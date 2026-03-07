// Centralized regex for matching inlay tokens in chat content.
// Used by both renderer/parsers and summarization sanitizers.
export const inlayTokenRegex = /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g;

export type InlayTokenKind = 'inlay' | 'inlayed' | 'inlayeddata'

export function getInlayTokenPayload(token: string): string | null {
    const match = token.match(/^{{(inlay|inlayed|inlayeddata)::(.+?)}}$/)
    return match?.[2] ?? null
}
