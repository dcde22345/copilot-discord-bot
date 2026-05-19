import { ThreadChannel } from "discord.js";
import type { Logger } from "pino";
import type { BotConfig } from "../config.js";
import type { SqliteSessionStore } from "../data/SqliteSessionStore.js";
import type { SessionRecord } from "../models/SessionRecord.js";
import type { PermissionHandler } from "@github/copilot-sdk";
export declare class SessionRuntimeManager {
    private readonly logger;
    private readonly config;
    private readonly store;
    private runtimes;
    private runtimeLocks;
    private pendingPermissions;
    private permissionPromptByMessageId;
    private activeTurnStatus;
    private lastRuntimeStartFailureAt;
    private readonly embeddingService;
    constructor(logger: Logger, config: BotConfig, store: SqliteSessionStore);
    invalidateRuntime(threadId: bigint): void;
    disposeAll(): Promise<void>;
    ensureSessionRecord(thread: ThreadChannel): Promise<SessionRecord>;
    private buildRagContext;
    sendUserMessage(thread: ThreadChannel, record: SessionRecord, userText: string): Promise<void>;
    updateTurnProgress(threadId: bigint, progressText: string): Promise<void>;
    notifyWaitingForApproval(threadId: bigint, permissionKind: string): Promise<void>;
    notifyApprovalResolved(threadId: bigint): Promise<void>;
    private tryUpdateTurnStatus;
    abort(threadId: bigint): Promise<void>;
    tryResolvePermission(threadId: bigint, approve: boolean, toolCallId?: string): boolean;
    tryResolvePermissionByPromptMessageId(promptMessageId: string, approve: boolean): {
        threadId: bigint;
    } | null;
    buildPermissionHandler(thread: ThreadChannel, cfg: ReturnType<SqliteSessionStore["readConfig"]>): PermissionHandler;
    private getOrCreateRuntime;
    private createRuntime;
    private buildRepoDisplay;
}
//# sourceMappingURL=SessionRuntimeManager.d.ts.map