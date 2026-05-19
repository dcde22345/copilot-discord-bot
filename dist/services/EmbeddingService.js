import OpenAI from "openai";
export class EmbeddingService {
    logger;
    config;
    openai = null;
    cache = new Map();
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        if (config.OPENAI_API_KEY) {
            this.openai = new OpenAI({
                apiKey: config.OPENAI_API_KEY,
            });
            this.logger.info("EmbeddingService initialized with OpenAI");
        }
        else {
            this.logger.warn("OPENAI_API_KEY not set, embedding service disabled");
        }
    }
    getTextToEmbed(userQuestion, assistantAnswer) {
        return `User: ${userQuestion}\nAssistant: ${assistantAnswer}`;
    }
    async getEmbedding(text) {
        if (!this.openai) {
            return null;
        }
        const cacheKey = text;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
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
        }
        catch (err) {
            this.logger.error({ err }, "Failed to generate embedding");
            return null;
        }
    }
    async getCombinedEmbedding(userQuestion, assistantAnswer) {
        const text = this.getTextToEmbed(userQuestion, assistantAnswer);
        return this.getEmbedding(text);
    }
}
//# sourceMappingURL=EmbeddingService.js.map