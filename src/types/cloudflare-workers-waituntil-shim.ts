declare module 'cloudflare:workers' {
    export const waitUntil: (promise: Promise<unknown>) => void;
}
