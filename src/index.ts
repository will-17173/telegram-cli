#!/usr/bin/env node
import { createApp } from './cli/app.js'

await createApp().parseAsync(process.argv)
