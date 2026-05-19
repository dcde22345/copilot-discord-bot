export interface ConversationUnit {
  id: number;
  threadId: string;
  userQuestion: string;
  assistantAnswer: string;
  createdUtc: Date;
  distance?: number;
}
