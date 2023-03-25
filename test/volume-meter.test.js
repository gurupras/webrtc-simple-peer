import { FakeAudioContext, FakeAudioWorkletNode, FakeMediaStream, FakeMediaTrack } from '@gurupras/test-helpers'
import { VolumeMeter } from '../src/frontend/volume-meter'

beforeAll(() => {
  global.AudioContext = FakeAudioContext
  global.AudioWorkletNode = FakeAudioWorkletNode
})

describe('VolumeMeter', () => {
  /** @type {VolumeMeter} */
  let vm
  let opts
  /** @type {FakeMediaStream} */
  let stream
  /** @type {FakeMediaTrack} */
  let audioTrack

  beforeEach(async () => {
    audioTrack = new FakeMediaTrack()
    stream = new FakeMediaStream()
    stream.addTrack(audioTrack)

    opts = { url: 'test' }
    vm = new VolumeMeter(stream, opts)
  })

  describe('start', () => {
    beforeEach(async () => {
    })
    test('Adds worklet module', async () => {
      await vm.start()
      expect(vm.context.audioWorklet.addModule).toHaveBeenCalledWith(opts.url)
    })
    test('Connects input stream --> worklet --> destination', async () => {
      const spy = jest.spyOn(vm.context, 'createMediaStreamSource')
      await vm.start()
      expect(spy).toHaveBeenCalledWith(stream)
      /** @type {FakeAudioNode} */
      const micStream = spy.mock.results[0].value
      expect(micStream.connect).toHaveBeenCalledWith(vm.node)
      expect(vm.node.connect).toHaveBeenCalledWith(vm.context.destination)
    })
    test('Sets up node.port.onmessage listener to add to volumes array', async () => {
      await vm.start()
      expect(vm.node.port.onmessage).toBeFunction()
      const volume = 5
      vm.node.port.onmessage({ data: { volume } })
      expect(vm.volumes).toEqual([volume])
    })
  })

  describe('setUpdateInterval', () => {
    const ms = 300
    test('Posts message to audioWorkletNode', async () => {
      vm.node = new FakeAudioWorkletNode()
      await vm.setUpdateInterval(ms)
      expect(vm.node.port.postMessage).toHaveBeenCalledWith({ updateIntervalMS: ms })
    })
  })

  describe('getVolume', () => {
    beforeEach(() => {
    })
    test('Returns 0 in case there are no volumes available', async () => {
      vm.volumes = []
      await expect(vm.getVolume()).resolves.toBe(0)
    })
    test('Returns average of volumes in array', async () => {
      vm.volumes = [1, 2, 3]
      await expect(vm.getVolume()).resolves.toBe(2)
    })
    test('Clears out volumes array once called', async () => {
      vm.volumes = [1, 2, 3]
      await expect(vm.getVolume()).toResolve()
      expect(vm.volumes).toEqual([])
    })
  })

  describe('stop', () => {
    test('Does not crash if setup() was not called', async () => {
      await expect(vm.stop()).toResolve()
    })
    test('Calls node.disconnect', async () => {
      vm.node = { disconnect: jest.fn() }
      await vm.stop()
      expect(vm.node.disconnect).toHaveBeenCalled()
    })

    test('Disconnects micStream', async () => {
      vm.micStream = { disconnect: jest.fn() }
      await vm.stop()
      expect(vm.micStream.disconnect).toHaveBeenCalled()
    })
    test('Closes the audioContext', async () => {
      await vm.stop()
      expect(vm.context.close).toHaveBeenCalled()
    })
  })
})
