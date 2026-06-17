// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	// maxCommandBytes caps term_send_command input. The base64-encoded form
	// adds ~33% overhead on the wire; 64 KiB raw keeps the RPC payload well
	// under 100 KiB and prevents a runaway model call from saturating the
	// renderer.
	maxCommandBytes = 64 * 1024
	// maxScrollbackBytes caps the returned scrollback to prevent a single
	// tool call from streaming gigabytes of history into the chat context.
	maxScrollbackBytes = 1 * 1024 * 1024
	// shellReadyPollInterval is how often term_send_command polls the shell
	// state when wait_for_output is requested. The old fixed 2 s sleep
	// wasted time on fast commands and truncated slow ones.
	shellReadyPollInterval = 100 * time.Millisecond
	// shellReadyMaxWait caps the polling loop so a hung shell can't pin the
	// tool call forever. 5 s is a reasonable default for interactive use.
	shellReadyMaxWait = 5 * time.Second
)

type TermGetScrollbackToolInput struct {
	WidgetId  string `json:"widget_id"`
	LineStart int    `json:"line_start,omitempty"`
	Count     int    `json:"count,omitempty"`
}

type CommandInfo struct {
	Command  string `json:"command"`
	Status   string `json:"status"`
	ExitCode *int   `json:"exitcode,omitempty"`
}

type TermGetScrollbackToolOutput struct {
	TotalLines         int          `json:"totallines"`
	LineStart          int          `json:"linestart"`
	LineEnd            int          `json:"lineend"`
	ReturnedLines      int          `json:"returnedlines"`
	Content            string       `json:"content"`
	SinceLastOutputSec *int         `json:"sincelastoutputsec,omitempty"`
	HasMore            bool         `json:"hasmore"`
	NextStart          *int         `json:"nextstart"`
	LastCommand        *CommandInfo `json:"lastcommand,omitempty"`
}

func parseTermGetScrollbackInput(input any) (*TermGetScrollbackToolInput, error) {
	const (
		DefaultCount = 200
		MaxCount     = 1000
	)

	result := &TermGetScrollbackToolInput{
		LineStart: 0,
		Count:     0,
	}

	if input == nil {
		result.Count = DefaultCount
		return result, nil
	}

	inputBytes, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal input: %w", err)
	}

	if err := json.Unmarshal(inputBytes, result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal input: %w", err)
	}

	if result.Count == 0 {
		result.Count = DefaultCount
	}

	if result.Count < 0 {
		return nil, fmt.Errorf("count must be positive")
	}

	result.Count = min(result.Count, MaxCount)

	return result, nil
}

func getTermScrollbackOutput(tabId string, widgetId string, rpcData wshrpc.CommandTermGetScrollbackLinesData) (*TermGetScrollbackToolOutput, error) {
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()

	fullBlockId, err := wcore.ResolveBlockIdFromPrefix(ctx, tabId, widgetId)
	if err != nil {
		return nil, err
	}

	rpcClient := wshclient.GetBareRpcClient()
	result, err := wshclient.TermGetScrollbackLinesCommand(
		rpcClient,
		rpcData,
		&wshrpc.RpcOpts{Route: wshutil.MakeFeBlockRouteId(fullBlockId)},
	)
	if err != nil {
		return nil, err
	}

	content := strings.Join(result.Lines, "\n")
	var effectiveLineEnd int
	if rpcData.LastCommand {
		effectiveLineEnd = result.LineStart + len(result.Lines)
	} else {
		effectiveLineEnd = min(rpcData.LineEnd, result.TotalLines)
	}
	hasMore := effectiveLineEnd < result.TotalLines

	var sinceLastOutputSec *int
	if result.LastUpdated > 0 {
		sec := max(0, int((time.Now().UnixMilli()-result.LastUpdated)/1000))
		sinceLastOutputSec = &sec
	}

	var nextStart *int
	if hasMore {
		nextStart = &effectiveLineEnd
	}

	blockORef := waveobj.MakeORef(waveobj.OType_Block, fullBlockId)
	rtInfo := wstore.GetRTInfo(blockORef)

	var lastCommand *CommandInfo
	if rtInfo != nil && rtInfo.ShellIntegration && rtInfo.ShellLastCmd != "" {
		cmdInfo := &CommandInfo{
			Command: rtInfo.ShellLastCmd,
		}
		if rtInfo.ShellState == "running-command" {
			cmdInfo.Status = "running"
		} else if rtInfo.ShellState == "ready" {
			cmdInfo.Status = "completed"
			exitCode := rtInfo.ShellLastCmdExitCode
			cmdInfo.ExitCode = &exitCode
		}
		lastCommand = cmdInfo
	}

	return &TermGetScrollbackToolOutput{
		TotalLines:         result.TotalLines,
		LineStart:          result.LineStart,
		LineEnd:            effectiveLineEnd,
		ReturnedLines:      len(result.Lines),
		Content:            content,
		SinceLastOutputSec: sinceLastOutputSec,
		HasMore:            hasMore,
		NextStart:          nextStart,
		LastCommand:        lastCommand,
	}, nil
}

func GetTermGetScrollbackToolDefinition(tabId string) uctypes.ToolDefinition {
	return uctypes.ToolDefinition{
		Name:        "term_get_scrollback",
		DisplayName: "Get Terminal Scrollback",
		Description: "Fetch terminal scrollback from a widget as plain text. Index 0 is the most recent line; indices increase going upward (older lines). Also returns last command and exit code if shell integration is enabled.",
		ToolLogName: "term:getscrollback",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"widget_id": map[string]any{
					"type":        "string",
					"description": "8-character widget ID of the terminal widget",
				},
				"line_start": map[string]any{
					"type":        "integer",
					"minimum":     0,
					"description": "Logical start index where 0 = most recent line (default: 0).",
				},
				"count": map[string]any{
					"type":        "integer",
					"minimum":     1,
					"description": "Number of lines to return from line_start (default: 200).",
				},
			},
			"required":             []string{"widget_id"},
			"additionalProperties": false,
		},
		ToolCallDesc: func(input any, output any, toolUseData *uctypes.UIMessageDataToolUse) string {
			parsed, err := parseTermGetScrollbackInput(input)
			if err != nil {
				return fmt.Sprintf("error parsing input: %v", err)
			}

			if parsed.LineStart == 0 && parsed.Count == 200 {
				return fmt.Sprintf("reading terminal output from %s (most recent %d lines)", parsed.WidgetId, parsed.Count)
			}
			lineEnd := parsed.LineStart + parsed.Count
			return fmt.Sprintf("reading terminal output from %s (lines %d-%d)", parsed.WidgetId, parsed.LineStart, lineEnd)
		},
		ToolApproval: func(input any) string {
			// Reading terminal output can leak secrets, file contents,
			// or command history. Require user approval for every call,
			// matching the gate on term_send_command.
			return uctypes.ApprovalNeedsApproval
		},
		ToolAnyCallback: func(input any, toolUseData *uctypes.UIMessageDataToolUse) (any, error) {
			parsed, err := parseTermGetScrollbackInput(input)
			if err != nil {
				return nil, err
			}

			lineEnd := parsed.LineStart + parsed.Count
			output, err := getTermScrollbackOutput(
				tabId,
				parsed.WidgetId,
				wshrpc.CommandTermGetScrollbackLinesData{
					LineStart:   parsed.LineStart,
					LineEnd:     lineEnd,
					LastCommand: false,
				},
			)
			if err != nil {
				return nil, fmt.Errorf("failed to get terminal scrollback: %w", err)
			}
			return output, nil
		},
	}
}

type TermCommandOutputToolInput struct {
	WidgetId string `json:"widget_id"`
}

func parseTermCommandOutputInput(input any) (*TermCommandOutputToolInput, error) {
	result := &TermCommandOutputToolInput{}

	if input == nil {
		return nil, fmt.Errorf("widget_id is required")
	}

	inputBytes, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal input: %w", err)
	}

	if err := json.Unmarshal(inputBytes, result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal input: %w", err)
	}

	if result.WidgetId == "" {
		return nil, fmt.Errorf("widget_id is required")
	}

	return result, nil
}

type TermSendCommandToolInput struct {
	WidgetId      string `json:"widget_id"`
	Command       string `json:"command"`
	WaitForOutput *bool  `json:"wait_for_output,omitempty"`
}

func parseTermSendCommandInput(input any) (*TermSendCommandToolInput, error) {
	result := &TermSendCommandToolInput{}
	if input == nil {
		return nil, fmt.Errorf("widget_id and command are required")
	}
	inputBytes, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal input: %w", err)
	}
	if err := json.Unmarshal(inputBytes, result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal input: %w", err)
	}
	if result.WidgetId == "" {
		return nil, fmt.Errorf("widget_id is required")
	}
	if result.Command == "" {
		return nil, fmt.Errorf("command is required")
	}
	// Reject embedded newlines. The terminal appends \r to the command and
	// the cooked-mode line discipline submits the line on LF — so a \n in
	// the input runs as two separate commands behind the user's back, even
	// though the approval dialog shows them concatenated. Force the model
	// to make a separate term_send_command call per command.
	if strings.ContainsAny(result.Command, "\n\r") {
		return nil, fmt.Errorf("command must not contain newlines or carriage returns (call term_send_command once per command)")
	}
	if len(result.Command) > maxCommandBytes {
		return nil, fmt.Errorf("command exceeds %d-byte limit (got %d bytes)", maxCommandBytes, len(result.Command))
	}
	return result, nil
}

func GetTermSendCommandToolDefinition(tabId string) uctypes.ToolDefinition {
	return uctypes.ToolDefinition{
		Name:        "term_send_command",
		DisplayName: "Run Command in Terminal",
		Description: "Execute a shell command in an open terminal widget. Sends the command text followed by Enter. If wait_for_output is true, returns the terminal scrollback after a short delay so you can see the result. Requires user approval before execution.",
		ToolLogName: "term:sendcommand",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"widget_id": map[string]any{
					"type":        "string",
					"description": "8-character widget ID of the terminal widget to run the command in",
				},
				"command": map[string]any{
					"type":        "string",
					"description": "The shell command to execute",
				},
				"wait_for_output": map[string]any{
					"type":        "boolean",
					"description": "If true, wait briefly and return terminal output after the command runs (default: true)",
				},
			},
			"required":             []string{"widget_id", "command"},
			"additionalProperties": false,
		},
		ToolCallDesc: func(input any, output any, toolUseData *uctypes.UIMessageDataToolUse) string {
			parsed, err := parseTermSendCommandInput(input)
			if err != nil {
				return fmt.Sprintf("error parsing input: %v", err)
			}
			return fmt.Sprintf("running in terminal %s: %s", parsed.WidgetId, parsed.Command)
		},
		ToolApproval: func(input any) string {
			return uctypes.ApprovalNeedsApproval
		},
		ToolAnyCallback: func(input any, toolUseData *uctypes.UIMessageDataToolUse) (any, error) {
			parsed, err := parseTermSendCommandInput(input)
			if err != nil {
				return nil, err
			}

			ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancelFn()

			fullBlockId, err := wcore.ResolveBlockIdFromPrefix(ctx, tabId, parsed.WidgetId)
			if err != nil {
				return nil, fmt.Errorf("terminal widget %q not found: %w", parsed.WidgetId, err)
			}

			inputBytes := []byte(parsed.Command + "\r")
			inputData64 := base64.StdEncoding.EncodeToString(inputBytes)

			rpcClient := wshclient.GetBareRpcClient()
			err = wshclient.ControllerInputCommand(
				rpcClient,
				wshrpc.CommandBlockInputData{
					BlockId:     fullBlockId,
					InputData64: inputData64,
				},
				&wshrpc.RpcOpts{},
			)
			if err != nil {
				return nil, fmt.Errorf("failed to send command to terminal: %w", err)
			}

			waitForOutput := true
			if parsed.WaitForOutput != nil {
				waitForOutput = *parsed.WaitForOutput
			}
			if waitForOutput {
				// Poll shell state instead of a fixed 2 s sleep. Fast
				// commands (echo hi) return in one poll interval; slow
				// commands (npm install) get up to 5 s of observation;
				// hung shells time out cleanly.
				if pollErr := waitForShellReady(fullBlockId); pollErr != nil {
					return map[string]any{"sent": true, "output_read": false, "note": fmt.Sprintf("command sent; could not observe completion: %v", pollErr)}, nil
				}
				output, err := getTermScrollbackOutput(
					tabId,
					parsed.WidgetId,
					wshrpc.CommandTermGetScrollbackLinesData{
						LineStart: 0,
						LineEnd:   50,
					},
				)
				if err != nil {
					// Surface as non-fatal output_read=false so the
					// model can retry the scrollback via
					// term_get_scrollback without re-executing.
					return map[string]any{"sent": true, "output_read": false, "note": fmt.Sprintf("command sent; could not read output: %v", err)}, nil
				}
				// Cap returned scrollback so a runaway model call
				// can't stream gigabytes of history into the chat
				// context.
				if len(output.Content) > maxScrollbackBytes {
					output.Content = output.Content[:maxScrollbackBytes] +
						fmt.Sprintf("\n... [truncated; full output exceeds %d bytes]", maxScrollbackBytes)
				}
				return map[string]any{"sent": true, "output_read": true, "output": output}, nil
			}

			return map[string]any{"sent": true}, nil
		},
	}
}

// waitForShellReady polls rtInfo.ShellState for the given block until the
// shell reports "ready" (or shell integration is disabled) or the
// shellReadyMaxWait deadline elapses. Replaces the previous fixed 2 s
// sleep. Returns nil on success or an error if the deadline passed.
func waitForShellReady(fullBlockId string) error {
	blockORef := waveobj.MakeORef(waveobj.OType_Block, fullBlockId)
	deadline := time.Now().Add(shellReadyMaxWait)
	for {
		rtInfo := wstore.GetRTInfo(blockORef)
		// shell integration disabled -> we can't observe completion;
		// give a single poll-interval grace and assume it ran.
		if rtInfo == nil || !rtInfo.ShellIntegration {
			time.Sleep(shellReadyPollInterval)
			return nil
		}
		if rtInfo.ShellState == "ready" {
			return nil
		}
		// "running-command" or unknown state: keep polling until deadline.
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out after %s waiting for shell to become ready", shellReadyMaxWait)
		}
		time.Sleep(shellReadyPollInterval)
	}
}

func GetTermCommandOutputToolDefinition(tabId string) uctypes.ToolDefinition {
	return uctypes.ToolDefinition{
		Name:        "term_command_output",
		DisplayName: "Get Last Command Output",
		Description: "Retrieve output from the most recent command in a terminal widget. Requires shell integration to be enabled. Returns the command text, exit code, and up to 1000 lines of output.",
		ToolLogName: "term:commandoutput",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"widget_id": map[string]any{
					"type":        "string",
					"description": "8-character widget ID of the terminal widget",
				},
			},
			"required":             []string{"widget_id"},
			"additionalProperties": false,
		},
		ToolCallDesc: func(input any, output any, toolUseData *uctypes.UIMessageDataToolUse) string {
			parsed, err := parseTermCommandOutputInput(input)
			if err != nil {
				return fmt.Sprintf("error parsing input: %v", err)
			}
			return fmt.Sprintf("reading last command output from %s", parsed.WidgetId)
		},
		ToolApproval: func(input any) string {
			// Reading the last command's output can leak secrets
			// passed on the command line (env, file paths). Require
			// user approval, matching term_send_command and
			// term_get_scrollback.
			return uctypes.ApprovalNeedsApproval
		},
		ToolAnyCallback: func(input any, toolUseData *uctypes.UIMessageDataToolUse) (any, error) {
			parsed, err := parseTermCommandOutputInput(input)
			if err != nil {
				return nil, err
			}

			ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancelFn()

			fullBlockId, err := wcore.ResolveBlockIdFromPrefix(ctx, tabId, parsed.WidgetId)
			if err != nil {
				return nil, err
			}

			blockORef := waveobj.MakeORef(waveobj.OType_Block, fullBlockId)
			rtInfo := wstore.GetRTInfo(blockORef)
			if rtInfo == nil || !rtInfo.ShellIntegration {
				return nil, fmt.Errorf("shell integration is not enabled for this terminal")
			}

			output, err := getTermScrollbackOutput(
				tabId,
				parsed.WidgetId,
				wshrpc.CommandTermGetScrollbackLinesData{
					LastCommand: true,
				},
			)
			if err != nil {
				return nil, fmt.Errorf("failed to get command output: %w", err)
			}
			return output, nil
		},
	}
}
