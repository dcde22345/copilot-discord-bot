import { type PermissionHandler } from "@github/copilot-sdk";
import type { Logger } from "pino";
import type { SessionRecord } from "../models/SessionRecord.js";
import type { SessionConfigState } from "../models/SessionConfigState.js";
export interface CopilotTurnOutcome {
    success: boolean;
    timedOut: boolean;
    errorMessage?: string;
}
export declare const CopilotTurnOutcome: {
    ok: () => CopilotTurnOutcome;
    timeout: () => CopilotTurnOutcome;
    failed: (error?: string) => CopilotTurnOutcome;
};
export declare class CopilotRuntime {
    private readonly logger;
    private readonly record;
    private readonly cfg;
    private readonly cwd;
    private readonly cliPath;
    private readonly turnTimeoutMs;
    private readonly sendToDiscord;
    private readonly sendProgress;
    private readonly permissionHandler;
    private readonly onConversationComplete?;
    private readonly ragContext?;
    private client;
    private session;
    private unsubscribe;
    private lastToolLabel;
    private turnLocked;
    private turnQueue;
    private currentUserMessage;
    constructor(logger: Logger, record: SessionRecord, cfg: SessionConfigState, cwd: string, cliPath: string | undefined, turnTimeoutMs: number, sendToDiscord: (text: string) => Promise<void>, sendProgress: (text: string) => Promise<void>, permissionHandler: PermissionHandler, onConversationComplete?: ((userQuestion: string, assistantAnswer: string) => void) | undefined, ragContext?: string | undefined);
    start(): Promise<void>;
    private probeCopilotCli;
    private ensureSession;
    private buildSystemMessage;
    private handleSessionEvent;
    private extractToolLabel;
    sendUserMessage(userText: string): Promise<CopilotTurnOutcome>;
    abort(): Promise<void>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=CopilotRuntime.d.ts.map