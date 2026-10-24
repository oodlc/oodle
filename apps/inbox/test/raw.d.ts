/** Vite raw imports (used to read wrangler.jsonc in tests). */
declare module '*?raw' {
  const text: string;
  export default text;
}
