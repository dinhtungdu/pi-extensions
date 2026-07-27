#!/usr/bin/env python3
# Copyright 2026 dinhtungdu
# SPDX-License-Identifier: MIT

import argparse
import os
import queue
import struct
import sys
import threading
from dataclasses import dataclass

INPUT_SPEAK = 1
INPUT_CANCEL = 2
INPUT_SHUTDOWN = 3
OUTPUT_READY = 1
OUTPUT_AUDIO_START = 2
OUTPUT_AUDIO_CHUNK = 3
OUTPUT_AUDIO_DONE = 4
OUTPUT_ERROR = 5
HEADER = struct.Struct("<BII")
MAX_FRAME_BYTES = 16 * 1024 * 1024


@dataclass
class Frame:
    frame_type: int
    request_id: int
    payload: bytes


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent MLX Qwen3-TTS worker")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--model-name", "--model-path", dest="model_path", required=True)
    parser.add_argument("--voice", default="Aiden")
    parser.add_argument("--instruct", default="")
    parser.add_argument("--language", default="english")
    parser.add_argument("--output-sample-rate", type=int, default=24000)
    parser.add_argument("--blocksize", type=int, default=4800)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--top-k", type=int, default=30)
    return parser.parse_args()


def read_exact(stream, size: int):
    output = bytearray()
    while len(output) < size:
        chunk = stream.read(size - len(output))
        if not chunk:
            return None
        output.extend(chunk)
    return bytes(output)


def read_frame(stream):
    header = read_exact(stream, HEADER.size)
    if header is None:
        return None
    frame_type, request_id, payload_size = HEADER.unpack(header)
    if payload_size > MAX_FRAME_BYTES:
        raise ValueError(f"input frame too large: {payload_size}")
    payload = read_exact(stream, payload_size)
    if payload is None:
        return None
    return Frame(frame_type, request_id, payload)


class Writer:
    def __init__(self, stream):
        self.stream = stream

    def send(self, frame_type: int, request_id: int, payload: bytes = b""):
        self.stream.write(HEADER.pack(frame_type, request_id, len(payload)))
        if payload:
            self.stream.write(payload)
        self.stream.flush()


class Worker:
    def __init__(self, args: argparse.Namespace, writer: Writer):
        from mlx_audio.tts.utils import load_model

        self.args = args
        self.writer = writer
        self.model = load_model(args.model_path)
        self.frames = queue.Queue()
        self.cancelled = set()
        self.cancel_lock = threading.Lock()

    def cancel(self, request_id: int):
        with self.cancel_lock:
            self.cancelled.add(request_id)

    def take_cancelled(self, request_id: int) -> bool:
        with self.cancel_lock:
            if request_id not in self.cancelled:
                return False
            self.cancelled.remove(request_id)
            return True

    def synthesize(self, frame: Frame):
        import numpy as np

        if self.take_cancelled(frame.request_id):
            self.writer.send(OUTPUT_AUDIO_DONE, frame.request_id)
            return
        text = frame.payload.decode("utf-8").strip()
        if not text:
            raise ValueError("empty synthesis text")

        started = False
        for result in self.model.generate(
            text=text,
            voice=self.args.voice,
            instruct=self.args.instruct or None,
            lang_code=self.args.language,
            temperature=self.args.temperature,
            top_k=self.args.top_k,
            max_tokens=1536,
            stream=True,
            streaming_interval=0.32,
            verbose=False,
        ):
            if self.take_cancelled(frame.request_id):
                self.writer.send(OUTPUT_AUDIO_DONE, frame.request_id)
                return
            sample_rate = int(result.sample_rate)
            if not started:
                self.writer.send(OUTPUT_AUDIO_START, frame.request_id, struct.pack("<I", sample_rate))
                started = True
            audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
            pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2", copy=False).tobytes()
            block_bytes = max(2, self.args.blocksize * 2)
            for offset in range(0, len(pcm), block_bytes):
                self.writer.send(OUTPUT_AUDIO_CHUNK, frame.request_id, pcm[offset : offset + block_bytes])

        if not started:
            self.writer.send(
                OUTPUT_AUDIO_START,
                frame.request_id,
                struct.pack("<I", self.args.output_sample_rate),
            )
        self.writer.send(OUTPUT_AUDIO_DONE, frame.request_id)


def reader_loop(worker: Worker):
    try:
        while True:
            frame = read_frame(sys.stdin.buffer)
            if frame is None:
                worker.frames.put(Frame(INPUT_SHUTDOWN, 0, b""))
                return
            if frame.frame_type == INPUT_CANCEL:
                worker.cancel(frame.request_id)
                continue
            worker.frames.put(frame)
            if frame.frame_type == INPUT_SHUTDOWN:
                return
    except Exception as error:
        print(f"voice TTS reader failed: {error}", file=sys.stderr, flush=True)
        worker.frames.put(Frame(INPUT_SHUTDOWN, 0, b""))


def main() -> int:
    args = parse_args()
    if not args.serve:
        raise ValueError("--serve is required")

    binary_stdout = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    writer = Writer(binary_stdout)

    try:
        worker = Worker(args, writer)
    except Exception as error:
        writer.send(OUTPUT_ERROR, 0, str(error).encode("utf-8"))
        raise

    threading.Thread(target=reader_loop, args=(worker,), daemon=True).start()
    writer.send(OUTPUT_READY, 0)

    while True:
        frame = worker.frames.get()
        if frame.frame_type == INPUT_SHUTDOWN:
            return 0
        if frame.frame_type != INPUT_SPEAK:
            writer.send(OUTPUT_ERROR, frame.request_id, f"unknown frame type {frame.frame_type}".encode())
            continue
        try:
            worker.synthesize(frame)
        except Exception as error:
            writer.send(OUTPUT_ERROR, frame.request_id, str(error).encode("utf-8"))
            print(f"voice TTS request {frame.request_id} failed: {error}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"voice TTS failed: {error}", file=sys.stderr, flush=True)
        raise
