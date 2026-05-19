import Database from "better-sqlite3";
import type { SessionRecord } from "../models/SessionRecord.js";
import type { SessionConfigState } from "../models/SessionConfigState.js";
import type { ConversationUnit } from "../models/ConversationUnit.js";
export declare class SqliteSessionStore {
    db: Database.Database;
    constructor(dataDir: string);
    getByThreadId(threadId: bigint): SessionRecord | null;
    upsert(record: SessionRecord): void;
    list(): SessionRecord[];
    readConfig(record: SessionRecord): SessionConfigState;
    writeConfig(cfg: SessionConfigState): string;
    saveConversationUnit(threadId: string, userQuestion: string, assistantAnswer: string, embeddingBuffer: Buffer | null): number;
    searchTopKConversations(queryEmbedding: Float32Array, k: number): ConversationUnit[];
    close(): void;
}
//# sourceMappingURL=SqliteSessionStore.d.ts.map