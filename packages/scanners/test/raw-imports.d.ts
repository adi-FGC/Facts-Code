/** Vite `?raw` imports (vitest runs tests through Vite): the file's text as a
 *  string. Lets tests read repo files without node:* (C1 covers tests too). */
declare module '*?raw' {
  const content: string;
  export default content;
}
