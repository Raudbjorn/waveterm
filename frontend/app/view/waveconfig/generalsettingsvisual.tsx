// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import type { WaveConfigEnv } from "./waveconfigenv";

function SettingsToggle({
    checked,
    label,
    description,
    onChange,
}: {
    checked: boolean;
    label: string;
    description: string;
    onChange: (checked: boolean) => void;
}) {
    return (
        <label className="flex items-start gap-3 p-4 border-b border-border cursor-pointer hover:bg-hoverbg transition-colors">
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="mt-1 cursor-pointer"
            />
            <div className="min-w-0">
                <div className="text-sm font-medium text-primary">{label}</div>
                <div className="text-xs text-secondary mt-1 leading-relaxed">{description}</div>
            </div>
        </label>
    );
}

function GeneralSettingsVisual({ model }: { model: WaveConfigViewModel }) {
    const env = useWaveEnv<WaveConfigEnv>();
    const fullConfig = useAtomValue(env.atoms.fullConfigAtom);
    const sendAltShortcutsToTerminal = fullConfig?.settings?.["app:altnumbertoterminal"] ?? false;
    const ctrlClickMovesCursor = fullConfig?.settings?.["term:ctrlclickmovescursor"] ?? false;

    const setSendAltShortcutsToTerminal = (enabled: boolean) => {
        fireAndForget(async () => {
            await env.rpc.SetConfigCommand(TabRpcClient, { "app:altnumbertoterminal": enabled });
            model.loadFile(model.getConfigFiles()[0]);
        });
    };

    const setCtrlClickMovesCursor = (enabled: boolean) => {
        fireAndForget(async () => {
            await env.rpc.SetConfigCommand(TabRpcClient, { "term:ctrlclickmovescursor": enabled });
            model.loadFile(model.getConfigFiles()[0]);
        });
    };

    return (
        <div className="h-full overflow-auto">
            <SettingsToggle
                checked={sendAltShortcutsToTerminal}
                label="Send Alt shortcuts to terminal"
                description="On Windows, send Alt+0 through Alt+9 and Alt+Q through Alt+P to the focused terminal instead of Wave app shortcuts."
                onChange={setSendAltShortcutsToTerminal}
            />
            <SettingsToggle
                checked={ctrlClickMovesCursor}
                label="Ctrl-click moves terminal cursor"
                description="Send left and right arrow keys when Ctrl-clicking within the current terminal input row."
                onChange={setCtrlClickMovesCursor}
            />
        </div>
    );
}

export { GeneralSettingsVisual };
