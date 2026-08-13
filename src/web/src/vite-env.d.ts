/// <reference types="vite/client" />

// Vite's `?worker` import suffix — used to bundle Monaco's web worker (see MonacoDiff.tsx).
declare module "*?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
