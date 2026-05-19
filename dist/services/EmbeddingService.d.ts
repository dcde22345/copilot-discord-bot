import type { Logger } from "pino";
import type { BotConfig } from "../config.js";
export declare class EmbeddingService {
    private readonly logger;
    private readonly config;
    private openai;
    private cache;
    constructor(logger: Logger, config: BotConfig);
    private getTextToEmbed;
    getEmbedding(text: string): Promise<Float32Array | null>;
    getCombinedEmbedding(userQuestion: string, assistantAnswer: string): Promise<Float32Array | null>;
}
//# sourceMappingURL=EmbeddingService.d.ts.map