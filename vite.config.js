import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Change this to "/<REPO_NAME>/" if deploying to a project page
const base = '/';

export default defineConfig({
  plugins: [react()],
  base
})
