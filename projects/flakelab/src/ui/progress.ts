export class ProgressReporter {
  #lastLabel: string | undefined

  start(label: string): void {
    this.#lastLabel = label
    process.stderr.write(`FlakeLab · ${label}...\n`)
  }

  done(detail?: string): void {
    if (!this.#lastLabel) {
      return
    }
    const detailSuffix = detail ? ` · ${detail}` : ""
    process.stderr.write(`✓ ${this.#lastLabel}${detailSuffix}\n`)
    this.#lastLabel = undefined
  }
}
