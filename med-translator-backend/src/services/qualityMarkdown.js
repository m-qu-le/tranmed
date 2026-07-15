const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

export function normalizeQualityMarkdown(markdown) {
    if (typeof markdown !== 'string') return markdown;
    return markdown
        .split(/\r?\n/)
        .filter(line => !HORIZONTAL_RULE.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
