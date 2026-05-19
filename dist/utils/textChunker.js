export function* chunkForDiscord(text, maxLen = 1900) {
    if (!text)
        return;
    text = text.replace(/\r\n/g, "\n");
    let start = 0;
    while (start < text.length) {
        const len = Math.min(maxLen, text.length - start);
        let split = text.lastIndexOf("\n", start + len - 1);
        // Avoid tiny leading chunks
        if (split <= start + 100) {
            split = start + len;
        }
        const part = text.slice(start, split).trimEnd();
        if (part.length > 0)
            yield part;
        start = split;
        while (start < text.length && text[start] === "\n")
            start++;
    }
}
//# sourceMappingURL=textChunker.js.map