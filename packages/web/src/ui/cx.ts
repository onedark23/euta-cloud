/** Join class names, skipping falsy parts. */
export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');
