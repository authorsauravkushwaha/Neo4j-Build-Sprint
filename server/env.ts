import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

/** Match npm/Vite's local configuration without exposing server values to clients. */
export function loadServerEnv(): void {
  // loadEnvFile never overwrites an existing environment value: host settings
  // win, then .env.local, then .env. Supported since Node 20.12.
  for (const path of ['.env.local', '.env']) {
    if (existsSync(path)) loadEnvFile(path)
  }
}
