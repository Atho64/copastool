// Merged Indonesian → English table. Split by source: static markup in
// index.html/overlay.html, and strings the TypeScript modules build at runtime.

import { UI_EN } from './dict/ui';
import { RUNTIME_EN } from './dict/runtime';

export const EN: Record<string, string> = { ...UI_EN, ...RUNTIME_EN };
