// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"log"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const BYTES_PER_GB = 1073741824

var (
	nvidiaSmiPath   string
	nvidiaSmiOnce   sync.Once
	nvidiaSmiAbsent bool
)

func getCpuData(values map[string]float64) {
	percentArr, err := cpu.Percent(0, false)
	if err != nil {
		return
	}
	if len(percentArr) > 0 {
		values[wshrpc.TimeSeries_Cpu] = percentArr[0]
	}
	percentArr, err = cpu.Percent(0, true)
	if err != nil {
		return
	}
	for idx, percent := range percentArr {
		values[wshrpc.TimeSeries_Cpu+":"+strconv.Itoa(idx)] = percent
	}
}

func getMemData(values map[string]float64) {
	memData, err := mem.VirtualMemory()
	if err != nil {
		return
	}
	values["mem:total"] = float64(memData.Total) / BYTES_PER_GB
	values["mem:available"] = float64(memData.Available) / BYTES_PER_GB
	values["mem:used"] = float64(memData.Used) / BYTES_PER_GB
	values["mem:free"] = float64(memData.Free) / BYTES_PER_GB
}

func detectNvidiaSmi() {
	nvidiaSmiOnce.Do(func() {
		path, err := exec.LookPath("nvidia-smi")
		if err != nil {
			nvidiaSmiAbsent = true
			return
		}
		nvidiaSmiPath = path
		log.Printf("sysinfo: nvidia-smi detected at %s\n", path)
	})
}

func parseGpuFloat(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" || s == "[N/A]" || s == "N/A" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

func getGpuData(values map[string]float64) {
	detectNvidiaSmi()
	if nvidiaSmiAbsent {
		return
	}
	out, err := exec.Command(nvidiaSmiPath,
		"--query-gpu=utilization.gpu,utilization.memory,memory.total,memory.used,temperature.gpu,power.draw,power.limit,fan.speed",
		"--format=csv,noheader,nounits",
	).Output()
	if err != nil {
		return
	}
	line := strings.TrimSpace(string(out))
	if line == "" {
		return
	}
	// only take the first GPU for now
	if nl := strings.IndexByte(line, '\n'); nl >= 0 {
		line = line[:nl]
	}
	fields := strings.Split(line, ",")
	if len(fields) < 8 {
		return
	}
	values["gpu:available"] = 1
	if v, ok := parseGpuFloat(fields[0]); ok {
		values[wshrpc.TimeSeries_Gpu] = v
	}
	if v, ok := parseGpuFloat(fields[1]); ok {
		values["gpu:memutil"] = v
	}
	if v, ok := parseGpuFloat(fields[2]); ok {
		values["gpu:memtotal"] = v / 1024 // MiB -> GiB
	}
	if v, ok := parseGpuFloat(fields[3]); ok {
		values["gpu:memused"] = v / 1024
	}
	if v, ok := parseGpuFloat(fields[4]); ok {
		values["gpu:temp"] = v
	}
	if v, ok := parseGpuFloat(fields[5]); ok {
		values["gpu:power"] = v
	}
	if v, ok := parseGpuFloat(fields[6]); ok {
		values["gpu:powerlimit"] = v
	}
	if v, ok := parseGpuFloat(fields[7]); ok {
		values["gpu:fan"] = v
	}
}

func generateSingleServerData(client *wshutil.WshRpc, connName string) {
	now := time.Now()
	values := make(map[string]float64)
	getCpuData(values)
	getMemData(values)
	getGpuData(values)
	tsData := wshrpc.TimeSeriesData{Ts: now.UnixMilli(), Values: values}
	event := wps.WaveEvent{
		Event:   wps.Event_SysInfo,
		Scopes:  []string{connName},
		Data:    tsData,
		Persist: 1024,
	}
	wshclient.EventPublishCommand(client, event, &wshrpc.RpcOpts{NoResponse: true})
}

func RunSysInfoLoop(client *wshutil.WshRpc, connName string) {
	defer func() {
		log.Printf("sysinfo loop ended conn:%s\n", connName)
	}()
	for {
		generateSingleServerData(client, connName)
		time.Sleep(1 * time.Second)
	}
}
