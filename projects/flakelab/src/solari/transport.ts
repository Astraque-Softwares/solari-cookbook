import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici"

export async function withSolariTransport<T>(operation: () => Promise<T>): Promise<T> {
  const previousDispatcher = getGlobalDispatcher()
  const dispatcher = new Agent({
    autoSelectFamily: false,
    connect: {
      family: 4,
      maxVersion: "TLSv1.2",
      ALPNProtocols: ["http/1.1"],
    },
  })
  setGlobalDispatcher(dispatcher)
  try {
    return await operation()
  } finally {
    setGlobalDispatcher(previousDispatcher)
    await dispatcher.close()
  }
}
