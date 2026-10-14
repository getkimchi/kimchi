import { parentPort, workerData } from "node:worker_threads"
import { recordingCheckpoint } from "./checkpoint.js"
import { type RecordingMetadata, recordingChunks } from "./recorder.js"

const { directory, metadata }: { directory: string; metadata: RecordingMetadata } = workerData
if (!parentPort) throw new Error("Recording checkpoint requires a worker thread")
parentPort.postMessage(await recordingCheckpoint(recordingChunks(directory, metadata), metadata.cols, metadata.rows))
