const SENSITIVE_NAMES = [
  "api_key",
  "apikey",
  "authorization",
  "password",
  "secret",
  "token",
] as const

function redactBearerTokens(value: string): string {
  const parts = value.split(/(\s+)/u)
  let redactNextValue = false
  for (let index = 0; index < parts.length; index += 1) {
    if (redactNextValue && parts[index].trim()) {
      parts[index] = "[REDACTED]"
      redactNextValue = false
    } else if (parts[index].toLowerCase() === "bearer") {
      redactNextValue = true
    }
  }
  return parts.join("")
}

function redactAssignments(value: string): string {
  let result = value
  for (const name of SENSITIVE_NAMES) {
    const pattern = new RegExp(`(${name}\\s*[:=]\\s*)[^\\s,;]+`, "giu")
    result = result.replace(pattern, "$1[REDACTED]")
  }
  return result
}

function redactUrlToken(token: string): string {
  if (!token.startsWith("http://") && !token.startsWith("https://")) {
    return token
  }
  try {
    const url = new URL(token)
    if (url.username || url.password) {
      url.username = "redacted"
      url.password = ""
    }
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_NAMES.some((sensitive) => name.toLowerCase().includes(sensitive))) {
        url.searchParams.set(name, "[REDACTED]")
      }
    }
    return url.toString()
  } catch {
    return token
  }
}

export function redactText(value: string): string {
  return redactAssignments(redactBearerTokens(value))
    .split(/(\s+)/u)
    .map(redactUrlToken)
    .join("")
}
