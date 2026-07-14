import { createApp } from '../../src/cli/app.js'

await createApp().parseAsync(process.argv)
