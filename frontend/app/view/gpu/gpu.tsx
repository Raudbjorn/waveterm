// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import type { MetaKeyAtomFnType, WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { cn, isBlank } from "@/util/util";
import * as jotai from "jotai";
import * as React from "react";

const HISTORY_LEN = 60;

type GpuSnapshot = {
    ts: number;
    util: number;
    memUsed: number;
    memTotal: number;
    memUtil: number;
    temp: number;
    power: number;
    powerLimit: number;
    fan: number;
};

type GpuEnv = WaveEnvSubset<{
    getConnStatusAtom: WaveEnv["getConnStatusAtom"];
    getBlockMetaKeyAtom: MetaKeyAtomFnType<"connection">;
}>;

function snapshotFromEvent(values: Record<string, number>, ts: number): GpuSnapshot | null {
    if (values == null || values["gpu:available"] !== 1) {
        return null;
    }
    return {
        ts,
        util: values["gpu"] ?? 0,
        memUsed: values["gpu:memused"] ?? 0,
        memTotal: values["gpu:memtotal"] ?? 0,
        memUtil: values["gpu:memutil"] ?? 0,
        temp: values["gpu:temp"] ?? 0,
        power: values["gpu:power"] ?? 0,
        powerLimit: values["gpu:powerlimit"] ?? 0,
        fan: values["gpu:fan"] ?? 0,
    };
}

export class GpuViewModel implements ViewModel {
    viewType = "gpu";
    blockId: string;
    env: GpuEnv;
    viewIcon: jotai.Atom<string>;
    viewName: jotai.Atom<string>;
    noPadding: jotai.Atom<boolean>;
    manageConnection: jotai.Atom<boolean>;
    filterOutNowsh: jotai.Atom<boolean>;
    connection: jotai.Atom<string>;
    connStatus: jotai.Atom<ConnStatus>;
    latestAtom: jotai.PrimitiveAtom<GpuSnapshot>;
    historyAtom: jotai.PrimitiveAtom<GpuSnapshot[]>;
    pushSnapshotAtom: jotai.WritableAtom<unknown, [GpuSnapshot], void>;

    constructor({ blockId, waveEnv }: ViewModelInitType) {
        this.blockId = blockId;
        this.env = waveEnv as GpuEnv;
        this.viewIcon = jotai.atom("microchip");
        this.viewName = jotai.atom("GPU");
        this.noPadding = jotai.atom(true);
        this.manageConnection = jotai.atom(true);
        this.filterOutNowsh = jotai.atom(true);
        this.latestAtom = jotai.atom<GpuSnapshot>(null) as jotai.PrimitiveAtom<GpuSnapshot>;
        this.historyAtom = jotai.atom<GpuSnapshot[]>([]) as jotai.PrimitiveAtom<GpuSnapshot[]>;
        this.pushSnapshotAtom = jotai.atom(null, (get, set, snap: GpuSnapshot) => {
            set(this.latestAtom, snap);
            const prev = get(this.historyAtom);
            const next = prev.length >= HISTORY_LEN ? [...prev.slice(prev.length - HISTORY_LEN + 1), snap] : [...prev, snap];
            set(this.historyAtom, next);
        });
        this.connection = jotai.atom((get) => {
            const connValue = get(this.env.getBlockMetaKeyAtom(blockId, "connection"));
            if (isBlank(connValue)) {
                return "local";
            }
            return connValue;
        });
        this.connStatus = jotai.atom((get) => {
            const connName = get(this.env.getBlockMetaKeyAtom(blockId, "connection"));
            return get(this.env.getConnStatusAtom(connName));
        });
    }

    get viewComponent(): ViewComponent {
        return GpuView;
    }
}

function tempColor(t: number): string {
    if (t >= 85) return "var(--error-color)";
    if (t >= 70) return "var(--warning-color)";
    if (t >= 55) return "#facc15";
    return "var(--success-color)";
}

function utilColor(u: number): string {
    if (u >= 90) return "#ef4444";
    if (u >= 70) return "#f59e0b";
    if (u >= 40) return "#3b82f6";
    return "#22c55e";
}

type SizeMode = "micro" | "tiny" | "compact" | "medium" | "full" | "strip" | "column";

type LayoutInfo = {
    width: number;
    height: number;
    mode: SizeMode;
};

function classifySize(width: number, height: number): SizeMode {
    if (width <= 0 || height <= 0) return "tiny";
    const aspect = width / height;
    if (height < 140 && width >= 360 && aspect >= 3.5) return "strip";
    if (width < 230 && height >= 320 && aspect <= 0.55) return "column";
    if (width < 160 || height < 90) return "micro";
    if (width < 240 || height < 150) return "tiny";
    if (width < 380 || height < 230) return "compact";
    if (width < 560 || height < 360) return "medium";
    return "full";
}

function useLayout(ref: React.RefObject<HTMLDivElement>): LayoutInfo {
    const [size, setSize] = React.useState({ width: 0, height: 0 });
    React.useLayoutEffect(() => {
        if (!ref.current) return;
        const el = ref.current;
        setSize({ width: el.clientWidth, height: el.clientHeight });
        const ro = new ResizeObserver((entries) => {
            for (const e of entries) {
                setSize({ width: e.contentRect.width, height: e.contentRect.height });
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return { ...size, mode: classifySize(size.width, size.height) };
}

type CircularGaugeProps = {
    value: number;
    max: number;
    label?: string;
    suffix: string;
    color: string;
    size: number;
};

function CircularGauge({ value, max, label, suffix, color, size }: CircularGaugeProps) {
    const stroke = Math.max(4, Math.round(size * 0.085));
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
    const dashOffset = circumference * (1 - pct);
    const center = size / 2;
    const mainFont = Math.max(14, Math.round(size * 0.27));
    const suffixFont = Math.max(10, Math.round(mainFont * 0.55));
    const labelFont = Math.max(8, Math.round(size * 0.075));
    return (
        <div className="relative shrink-0" style={{ width: size, height: size }}>
            <svg width={size} height={size} className="-rotate-90">
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    stroke="var(--border-color)"
                    strokeOpacity={0.3}
                    strokeWidth={stroke}
                    fill="none"
                />
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    stroke={color}
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    fill="none"
                    strokeDasharray={circumference}
                    strokeDashoffset={dashOffset}
                    style={{ transition: "stroke-dashoffset 0.6s ease, stroke 0.6s ease" }}
                />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
                <div className="font-bold tabular-nums flex items-baseline" style={{ color, fontSize: mainFont }}>
                    {value.toFixed(0)}
                    <span className="ml-0.5" style={{ fontSize: suffixFont }}>{suffix}</span>
                </div>
                {label && (
                    <div
                        className="uppercase tracking-wider text-[var(--grey-text-color)] mt-1"
                        style={{ fontSize: labelFont }}
                    >
                        {label}
                    </div>
                )}
            </div>
        </div>
    );
}

type StatCardProps = {
    label: string;
    value: string;
    sub?: string;
    color?: string;
    icon?: string;
    dense?: boolean;
};

function StatCard({ label, value, sub, color, icon, dense }: StatCardProps) {
    return (
        <div
            className={cn(
                "flex-1 min-w-0 bg-[var(--panel-bg-color)] border border-[var(--border-color)] rounded-lg flex flex-col",
                dense ? "px-2 py-1.5" : "px-3 py-2.5"
            )}
        >
            <div
                className={cn(
                    "uppercase tracking-wider text-[var(--grey-text-color)] flex items-center gap-1 truncate",
                    dense ? "text-[9px]" : "text-[10px]"
                )}
            >
                {icon && <i className={cn("fa-solid", `fa-${icon}`)} />}
                <span className="truncate">{label}</span>
            </div>
            <div
                className={cn("font-semibold tabular-nums mt-0.5 truncate", dense ? "text-sm" : "text-xl")}
                style={color ? { color } : undefined}
            >
                {value}
            </div>
            {sub && !dense && <div className="text-[11px] text-[var(--grey-text-color)] tabular-nums truncate">{sub}</div>}
        </div>
    );
}

type StatPillProps = {
    label: string;
    value: string;
    color?: string;
};

function StatPill({ label, value, color }: StatPillProps) {
    return (
        <div className="flex items-center gap-1 min-w-0">
            <span className="text-[10px] uppercase tracking-wider text-[var(--grey-text-color)]">{label}</span>
            <span className="text-xs font-semibold tabular-nums truncate" style={color ? { color } : undefined}>
                {value}
            </span>
        </div>
    );
}

type MemoryBarProps = {
    used: number;
    total: number;
    compact?: boolean;
};

function MemoryBar({ used, total, compact }: MemoryBarProps) {
    const pct = total > 0 ? Math.max(0, Math.min(1, used / total)) : 0;
    const barColor = pct > 0.9 ? "#ef4444" : pct > 0.75 ? "#f59e0b" : "var(--accent-color)";
    return (
        <div className="w-full min-w-0">
            <div className={cn("flex justify-between items-baseline gap-2 min-w-0", compact ? "mb-1" : "mb-1.5")}>
                <div
                    className={cn(
                        "uppercase tracking-wider text-[var(--grey-text-color)] shrink-0",
                        compact ? "text-[10px]" : "text-xs"
                    )}
                >
                    VRAM
                </div>
                <div className={cn("tabular-nums text-right truncate min-w-0", compact ? "text-[11px]" : "text-sm")}>
                    <span className="font-semibold">{used.toFixed(1)}</span>
                    <span className="text-[var(--grey-text-color)]"> / {total.toFixed(1)} GB</span>
                    {!compact && (
                        <span className="text-[var(--grey-text-color)] ml-2">({(pct * 100).toFixed(0)}%)</span>
                    )}
                </div>
            </div>
            <div
                className={cn("rounded-full bg-[var(--border-color)]/40 overflow-hidden", compact ? "h-1.5" : "h-3")}
            >
                <div
                    className="h-full rounded-full"
                    style={{
                        width: `${pct * 100}%`,
                        background: barColor,
                        transition: "width 0.6s ease, background 0.6s ease",
                    }}
                />
            </div>
        </div>
    );
}

type SparklineProps = {
    points: number[];
    color: string;
    height?: number;
};

function Sparkline({ points, color, height = 60 }: SparklineProps) {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [width, setWidth] = React.useState(300);
    React.useEffect(() => {
        if (!containerRef.current) return;
        const ro = new ResizeObserver((entries) => {
            for (const e of entries) {
                setWidth(e.contentRect.width);
            }
        });
        ro.observe(containerRef.current);
        return () => ro.disconnect();
    }, []);
    if (points.length < 2) {
        return <div ref={containerRef} style={{ height }} className="w-full" />;
    }
    const max = 100;
    const stepX = width / Math.max(1, HISTORY_LEN - 1);
    const offset = (HISTORY_LEN - points.length) * stepX;
    const coords = points.map((v, i) => {
        const x = offset + i * stepX;
        const y = height - (Math.min(max, Math.max(0, v)) / max) * (height - 4) - 2;
        return [x, y] as const;
    });
    const linePath = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const areaPath =
        linePath +
        ` L${coords[coords.length - 1][0].toFixed(1)},${height} L${coords[0][0].toFixed(1)},${height} Z`;
    const gradId = "gpu-spark-grad";
    return (
        <div ref={containerRef} style={{ height }} className="w-full">
            <svg width={width} height={height}>
                <defs>
                    <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity={0.5} />
                        <stop offset="100%" stopColor={color} stopOpacity={0} />
                    </linearGradient>
                </defs>
                <path d={areaPath} fill={`url(#${gradId})`} />
                <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </svg>
        </div>
    );
}

function NoGpuState({ mode }: { mode: SizeMode }) {
    if (mode === "micro" || mode === "tiny") {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center text-center px-2 text-[var(--grey-text-color)]">
                <i className="fa-solid fa-microchip text-2xl mb-1" />
                <div className="text-xs font-semibold">No GPU</div>
            </div>
        );
    }
    return (
        <div className="w-full h-full flex flex-col items-center justify-center text-center px-6">
            <i className="fa-solid fa-microchip text-5xl text-[var(--grey-text-color)] mb-4" />
            <div className="text-xl font-semibold mb-2">No GPU detected</div>
            <div className="text-sm text-[var(--grey-text-color)] max-w-md">
                The GPU monitor needs <code className="px-1 rounded bg-[var(--panel-bg-color)]">nvidia-smi</code> on the
                target machine. Install NVIDIA drivers, then reopen this block.
            </div>
        </div>
    );
}

function WaitingState({ mode }: { mode: SizeMode }) {
    if (mode === "micro" || mode === "tiny") {
        return (
            <div className="w-full h-full flex items-center justify-center text-[var(--grey-text-color)]">
                <i className="fa-solid fa-microchip text-xl animate-pulse" />
            </div>
        );
    }
    return (
        <div className="w-full h-full flex flex-col items-center justify-center text-center text-[var(--grey-text-color)]">
            <i className="fa-solid fa-microchip text-4xl mb-3 animate-pulse" />
            <div className="text-sm">Waiting for GPU data…</div>
        </div>
    );
}

type LayoutProps = {
    snap: GpuSnapshot;
    history: GpuSnapshot[];
    layout: LayoutInfo;
};

function StripLayout({ snap, layout }: LayoutProps) {
    const utilC = utilColor(snap.util);
    const tempC = tempColor(snap.temp);
    const gaugeSize = Math.max(48, Math.min(layout.height - 10, 92));
    const memPct = snap.memTotal > 0 ? (snap.memUsed / snap.memTotal) * 100 : 0;
    const memColor = memPct > 90 ? "#ef4444" : memPct > 75 ? "#f59e0b" : "var(--accent-color)";
    const showFullStats = layout.width >= 560;
    const showMem = layout.width >= 440;
    return (
        <div className="w-full h-full flex items-center gap-3 px-3 py-1.5 overflow-hidden">
            <CircularGauge value={snap.util} max={100} suffix="%" color={utilC} size={gaugeSize} />
            {showMem && (
                <>
                    <div className="self-stretch w-px bg-[var(--border-color)] opacity-50 my-2 shrink-0" />
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                        <div className="flex items-baseline gap-2 min-w-0">
                            <span className="text-[10px] uppercase tracking-wider text-[var(--grey-text-color)] shrink-0">
                                VRAM
                            </span>
                            <span className="text-xs tabular-nums truncate min-w-0">
                                <span className="font-semibold">{snap.memUsed.toFixed(1)}</span>
                                <span className="text-[var(--grey-text-color)]"> / {snap.memTotal.toFixed(1)} GB</span>
                                <span className="text-[var(--grey-text-color)] ml-1">({memPct.toFixed(0)}%)</span>
                            </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-[var(--border-color)]/40 overflow-hidden">
                            <div
                                className="h-full rounded-full"
                                style={{
                                    width: `${memPct}%`,
                                    background: memColor,
                                    transition: "width 0.6s ease, background 0.6s ease",
                                }}
                            />
                        </div>
                    </div>
                </>
            )}
            <div className="self-stretch w-px bg-[var(--border-color)] opacity-50 my-2 shrink-0" />
            <div className="flex items-center gap-3 shrink-0">
                <StatPill label="temp" value={`${snap.temp.toFixed(0)}°C`} color={tempC} />
                <StatPill label="pwr" value={`${snap.power.toFixed(0)}W`} />
                {showFullStats && <StatPill label="fan" value={`${snap.fan.toFixed(0)}%`} />}
            </div>
        </div>
    );
}

function ColumnLayout({ snap, history, layout }: LayoutProps) {
    const utilC = utilColor(snap.util);
    const tempC = tempColor(snap.temp);
    const gaugeSize = Math.max(80, Math.min(layout.width - 16, layout.height * 0.32, 160));
    const showSparkline = layout.height >= 520;
    const utilHistory = history.map((s) => s.util);
    return (
        <div className="w-full h-full flex flex-col gap-2 p-2 overflow-hidden">
            <div className="flex justify-center shrink-0">
                <CircularGauge value={snap.util} max={100} suffix="%" color={utilC} size={gaugeSize} />
            </div>
            <div className="shrink-0">
                <MemoryBar used={snap.memUsed} total={snap.memTotal} compact />
            </div>
            <div className="flex flex-col gap-1.5 min-h-0">
                <StatCard label="Temp" value={`${snap.temp.toFixed(0)}°C`} color={tempC} icon="temperature-half" dense />
                <StatCard label="Power" value={`${snap.power.toFixed(0)} W`} icon="bolt" dense />
                <StatCard label="Fan" value={`${snap.fan.toFixed(0)}%`} icon="fan" dense />
                <StatCard label="Mem Bus" value={`${snap.memUtil.toFixed(0)}%`} icon="memory" dense />
            </div>
            {showSparkline && (
                <div className="shrink-0 border-t border-[var(--border-color)] pt-1.5">
                    <div className="text-[10px] uppercase tracking-wider text-[var(--grey-text-color)] mb-0.5">
                        last 60s
                    </div>
                    <Sparkline points={utilHistory} color={utilC} height={36} />
                </div>
            )}
        </div>
    );
}

function MicroLayout({ snap, layout }: LayoutProps) {
    const utilC = utilColor(snap.util);
    const gaugeSize = Math.max(48, Math.min(layout.width - 12, layout.height - 12));
    return (
        <div className="w-full h-full flex items-center justify-center p-1">
            <CircularGauge value={snap.util} max={100} suffix="%" color={utilC} size={gaugeSize} />
        </div>
    );
}

function TinyLayout({ snap, layout }: LayoutProps) {
    const utilC = utilColor(snap.util);
    const tempC = tempColor(snap.temp);
    const gaugeSize = Math.max(60, Math.min(layout.width * 0.55, layout.height - 30, 110));
    const memPct = snap.memTotal > 0 ? (snap.memUsed / snap.memTotal) * 100 : 0;
    return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 p-2">
            <CircularGauge value={snap.util} max={100} suffix="%" color={utilC} size={gaugeSize} />
            <div className="flex gap-2.5 text-[11px] tabular-nums leading-tight items-baseline">
                <span style={{ color: tempC }}>
                    <span className="font-semibold">{snap.temp.toFixed(0)}</span>°C
                </span>
                <span className="text-[var(--grey-text-color)]">·</span>
                <span>
                    <span className="font-semibold">{memPct.toFixed(0)}</span>
                    <span className="text-[var(--grey-text-color)]">% vram</span>
                </span>
            </div>
        </div>
    );
}

function CompactLayout({ snap, layout }: LayoutProps) {
    const utilC = utilColor(snap.util);
    const tempC = tempColor(snap.temp);
    const gaugeSize = Math.max(80, Math.min(layout.width * 0.35, layout.height - 60, 130));
    return (
        <div className="w-full h-full flex flex-col gap-2.5 p-3 overflow-hidden">
            <div className="flex items-center gap-3 min-w-0">
                <CircularGauge value={snap.util} max={100} suffix="%" color={utilC} size={gaugeSize} />
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    <MemoryBar used={snap.memUsed} total={snap.memTotal} compact />
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                        <StatPill label="temp" value={`${snap.temp.toFixed(0)}°C`} color={tempC} />
                        <StatPill label="pwr" value={`${snap.power.toFixed(0)}W`} />
                        <StatPill label="fan" value={`${snap.fan.toFixed(0)}%`} />
                    </div>
                </div>
            </div>
        </div>
    );
}

function MediumLayout({ snap, layout }: LayoutProps) {
    const utilC = utilColor(snap.util);
    const tempC = tempColor(snap.temp);
    const gaugeSize = Math.max(110, Math.min(layout.width * 0.32, layout.height * 0.55, 160));
    return (
        <div className="w-full h-full flex flex-col gap-3 p-4 overflow-hidden">
            <div className="flex items-center gap-4 min-w-0">
                <CircularGauge value={snap.util} max={100} label="GPU" suffix="%" color={utilC} size={gaugeSize} />
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                    <MemoryBar used={snap.memUsed} total={snap.memTotal} />
                    <div className="grid grid-cols-3 gap-2">
                        <StatCard label="Temp" value={`${snap.temp.toFixed(0)}°C`} color={tempC} icon="temperature-half" dense />
                        <StatCard label="Power" value={`${snap.power.toFixed(0)}W`} icon="bolt" dense />
                        <StatCard label="Fan" value={`${snap.fan.toFixed(0)}%`} icon="fan" dense />
                    </div>
                </div>
            </div>
        </div>
    );
}

function FullLayout({ snap, history, layout }: LayoutProps) {
    const utilC = utilColor(snap.util);
    const tempC = tempColor(snap.temp);
    const utilHistory = history.map((s) => s.util);
    const powerPct = snap.powerLimit > 0 ? (snap.power / snap.powerLimit) * 100 : 0;
    const gaugeSize = Math.min(layout.width * 0.28, layout.height * 0.45, 200);
    const showSparkline = layout.height >= 380;
    return (
        <div className="w-full h-full overflow-auto p-5 flex flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                    <CircularGauge value={snap.util} max={100} label="GPU Util" suffix="%" color={utilC} size={gaugeSize} />
                </div>
                <div className="flex-1 flex flex-col gap-3 min-w-0">
                    <MemoryBar used={snap.memUsed} total={snap.memTotal} />
                    <div className="grid grid-cols-2 gap-2.5">
                        <StatCard
                            label="Temperature"
                            value={`${snap.temp.toFixed(0)}°C`}
                            color={tempC}
                            icon="temperature-half"
                        />
                        <StatCard
                            label="Power"
                            value={`${snap.power.toFixed(1)} W`}
                            sub={snap.powerLimit > 0 ? `of ${snap.powerLimit.toFixed(0)} W (${powerPct.toFixed(0)}%)` : undefined}
                            icon="bolt"
                        />
                        <StatCard label="Fan" value={`${snap.fan.toFixed(0)}%`} icon="fan" />
                        <StatCard label="Mem Bus" value={`${snap.memUtil.toFixed(0)}%`} icon="memory" />
                    </div>
                </div>
            </div>
            {showSparkline && (
                <div className="bg-[var(--panel-bg-color)] border border-[var(--border-color)] rounded-lg p-3">
                    <div className="flex justify-between items-baseline mb-1">
                        <div className="text-xs uppercase tracking-wider text-[var(--grey-text-color)]">
                            Utilization · last {Math.min(HISTORY_LEN, history.length)}s
                        </div>
                        <div className="text-xs text-[var(--grey-text-color)] tabular-nums">
                            avg{" "}
                            {(utilHistory.reduce((a, b) => a + b, 0) / Math.max(1, utilHistory.length)).toFixed(0)}% · max{" "}
                            {Math.max(0, ...utilHistory).toFixed(0)}%
                        </div>
                    </div>
                    <Sparkline points={utilHistory} color={utilC} />
                </div>
            )}
        </div>
    );
}

function GpuView({ model }: ViewComponentProps<GpuViewModel>) {
    const connName = jotai.useAtomValue(model.connection);
    const connStatus = jotai.useAtomValue(model.connStatus);
    const latest = jotai.useAtomValue(model.latestAtom);
    const history = jotai.useAtomValue(model.historyAtom);
    const pushSnapshot = jotai.useSetAtom(model.pushSnapshotAtom);
    const [waitedTooLong, setWaitedTooLong] = React.useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);
    const layout = useLayout(containerRef);

    React.useEffect(() => {
        if (connStatus?.status != "connected") return;
        globalStore.set(model.latestAtom, null);
        globalStore.set(model.historyAtom, []);
        setWaitedTooLong(false);
        const startedAt = Date.now();
        const timeout = setTimeout(() => {
            if (Date.now() - startedAt >= 2500 && globalStore.get(model.latestAtom) == null) {
                setWaitedTooLong(true);
            }
        }, 2800);
        const unsub = waveEventSubscribeSingle({
            eventType: "sysinfo",
            scope: connName,
            handler: (event) => {
                const data = event.data as { ts: number; values: Record<string, number> };
                if (data == null) return;
                const snap = snapshotFromEvent(data.values, data.ts);
                if (snap == null) {
                    setWaitedTooLong(true);
                    return;
                }
                setWaitedTooLong(false);
                pushSnapshot(snap);
            },
        });
        return () => {
            clearTimeout(timeout);
            unsub();
        };
    }, [connName, connStatus?.status, pushSnapshot, model]);

    if (connStatus?.status != "connected") {
        return <div ref={containerRef} className="w-full h-full" />;
    }

    let content: React.ReactNode;
    if (latest == null) {
        content = waitedTooLong ? <NoGpuState mode={layout.mode} /> : <WaitingState mode={layout.mode} />;
    } else {
        const props: LayoutProps = { snap: latest, history, layout };
        switch (layout.mode) {
            case "strip":
                content = <StripLayout {...props} />;
                break;
            case "column":
                content = <ColumnLayout {...props} />;
                break;
            case "micro":
                content = <MicroLayout {...props} />;
                break;
            case "tiny":
                content = <TinyLayout {...props} />;
                break;
            case "compact":
                content = <CompactLayout {...props} />;
                break;
            case "medium":
                content = <MediumLayout {...props} />;
                break;
            default:
                content = <FullLayout {...props} />;
        }
    }

    return (
        <div ref={containerRef} className="w-full h-full overflow-hidden">
            {content}
        </div>
    );
}
