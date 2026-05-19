export interface SessionRecord {
  threadId: bigint;
  guildId: bigint;
  parentChannelId: bigint;
  copilotSessionId: string;
  repoPath: string | null;
  configJson: string;
  createdUtc: Date;
  updatedUtc: Date;
}
