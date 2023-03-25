
class VolumeMeter {
  /**
   *
   * @param {MediaStream} mediaStream
   */
  constructor (mediaStream, opts = {}) {
    /** @type {MediaStream} */
    this.mediaStream = mediaStream
    /** @type {AudioContext} */
    this.context = new AudioContext()
    const { url = 'volume-meter-module' } = opts
    this.url = url
    this.volumes = []
  }

  async start () {
    await this.context.audioWorklet.addModule(this.url)

    const micStream = this.micStream = this.context.createMediaStreamSource(this.mediaStream)
    const node = this.node = new AudioWorkletNode(this.context, 'volume-meter')
    node.port.onmessage = e => {
      const { data: { volume } } = e
      this.volumes.push(volume)
    }
    micStream
      .connect(node)
      .connect(this.context.destination)
  }

  async setUpdateInterval (milliseconds) {
    this.node.port.postMessage({ updateIntervalMS: milliseconds })
  }

  async getVolume () {
    if (this.volumes.length === 0) {
      return 0
    }
    const avg = this.volumes.reduce((a, b) => a + b, 0) / this.volumes.length
    this.volumes = []
    return avg
  }

  async stop () {
    if (this.node) {
      this.node.disconnect()
    }
    if (this.micStream) {
      this.micStream.disconnect()
    }
    await this.context.close()
  }
}

module.exports = {
  VolumeMeter
}
