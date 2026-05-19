import OpenAI from "openai";
import type { Logger } from "pino";
import type { BotConfig } from "../config.js";

export class EmbeddingService {
  private openai: OpenAI | null = null;
  private cache = new Map<string, Float32Array>();

  constructor(
    private readonly logger: Logger,
    private readonly config: BotConfig
  ) {
    if (config.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: config.OPENAI_API_KEY,
      });
      this.logger.info("EmbeddingService initialized with OpenAI");
    } else {
      this.logger.warn("OPENAI_API_KEY not set, embedding service disabled");
    }
  }

  private getTextToEmbed(userQuestion: string, assistantAnswer: string): string {
    return `User: ${userQuestion}\nAssistant: ${assistantAnswer}`;
  }

  async getEmbedding(text: string): Promise<Float32Array | null> {
    if (!this.openai) {
      return null;
    }

    const cacheKey = text;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    try {
      const response = await this.openai.embeddings.create({
        model: this.config.EMBEDDING_MODEL || "text-embedding-3-small",
        input: text,
      });

      const embedding = new Float32Array(response.data[0].embedding);
      this.cache.set(cacheKey, embedding);
      this.logger.debug({ textLength: text.length }, "Embedding generated");
      return embedding;
    } catch (err) {
      this.logger.error({ err }, "Failed to generate embedding");
      return null;
    }
  }

  async getCombinedEmbedding(userQuestion: string, assistantAnswer: string): Promise<Float32Array | null> {
    const text = this.getTextToEmbed(userQuestion, assistantAnswer);
    return this.getEmbedding(text);
  }
}
