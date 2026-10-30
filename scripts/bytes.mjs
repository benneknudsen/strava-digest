/** UTF-8 byte length of a string: what "bytes" means, as opposed to `s.length` characters. */
export const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');
