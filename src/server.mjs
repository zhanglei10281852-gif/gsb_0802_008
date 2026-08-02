import { createApiServer } from './http.mjs'
import { createServices } from './services.mjs'

const { registry, resolver } = createServices()
const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '127.0.0.1'
const server = createApiServer({ registry, resolver })

server.listen(port, host, () => {
  console.log(`release-symbol-resolver-api listening on http://${host}:${port}`)
})
