// Copyright 2026 dinhtungdu
// SPDX-License-Identifier: MIT

#include "parakeet_capi.h"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr std::uint8_t kAudioFrame = 1;
constexpr std::uint8_t kReset = 2;
constexpr std::uint8_t kShutdown = 3;
constexpr int kEventEou = 1;
constexpr int kEventEob = 2;
constexpr std::size_t kMaxFrameBytes = 1024 * 1024;

struct ContextDeleter {
	void operator()(parakeet_ctx* value) const { parakeet_capi_free(value); }
};

struct StreamDeleter {
	void operator()(parakeet_stream* value) const { parakeet_capi_stream_free(value); }
};

using ContextPtr = std::unique_ptr<parakeet_ctx, ContextDeleter>;
using StreamPtr = std::unique_ptr<parakeet_stream, StreamDeleter>;

std::string jsonEscape(const std::string& value) {
	std::string output;
	output.reserve(value.size() + 16);
	for (unsigned char character : value) {
		switch (character) {
			case '"': output += "\\\""; break;
			case '\\': output += "\\\\"; break;
			case '\b': output += "\\b"; break;
			case '\f': output += "\\f"; break;
			case '\n': output += "\\n"; break;
			case '\r': output += "\\r"; break;
			case '\t': output += "\\t"; break;
			default:
				if (character < 0x20) {
					constexpr char digits[] = "0123456789abcdef";
					output += "\\u00";
					output += digits[(character >> 4) & 0x0f];
					output += digits[character & 0x0f];
				} else {
					output += static_cast<char>(character);
				}
		}
	}
	return output;
}

void emit(const std::string& type, const std::string& fields = "") {
	std::cout << "{\"type\":\"" << type << "\"";
	if (!fields.empty()) std::cout << ',' << fields;
	std::cout << "}\n" << std::flush;
}

bool readExact(char* destination, std::size_t length) {
	std::size_t offset = 0;
	while (offset < length) {
		std::cin.read(destination + offset, static_cast<std::streamsize>(length - offset));
		const auto count = static_cast<std::size_t>(std::cin.gcount());
		if (count == 0) return false;
		offset += count;
	}
	return true;
}

std::uint32_t decodeU32Le(const unsigned char* bytes) {
	return static_cast<std::uint32_t>(bytes[0]) |
		(static_cast<std::uint32_t>(bytes[1]) << 8) |
		(static_cast<std::uint32_t>(bytes[2]) << 16) |
		(static_cast<std::uint32_t>(bytes[3]) << 24);
}

std::string trim(const std::string& value) {
	const auto first = value.find_first_not_of(" \t\r\n");
	if (first == std::string::npos) return "";
	const auto last = value.find_last_not_of(" \t\r\n");
	return value.substr(first, last - first + 1);
}

class Worker {
public:
	explicit Worker(const std::string& modelPath) : context_(parakeet_capi_load(modelPath.c_str())) {
		if (!context_) throw std::runtime_error("failed to load Parakeet model: " + modelPath);
		reset();
	}

	void reset() {
		stream_.reset();
		transcript_.clear();
		stream_.reset(parakeet_capi_stream_begin(context_.get()));
		if (!stream_) {
			const char* message = parakeet_capi_last_error(context_.get());
			throw std::runtime_error(message ? message : "failed to begin Parakeet stream");
		}
	}

	void feed(const std::vector<unsigned char>& payload) {
		if (payload.size() % 2 != 0) throw std::runtime_error("PCM16 frame has odd byte length");
		std::vector<float> samples(payload.size() / 2);
		for (std::size_t index = 0; index < samples.size(); ++index) {
			const auto low = static_cast<std::uint16_t>(payload[index * 2]);
			const auto high = static_cast<std::uint16_t>(payload[index * 2 + 1]) << 8;
			const auto sample = static_cast<std::int16_t>(low | high);
			samples[index] = static_cast<float>(sample) / 32768.0f;
		}

		int events = 0;
		char* result = parakeet_capi_stream_feed(
			stream_.get(), samples.data(), static_cast<int>(samples.size()), &events
		);
		if (!result) {
			const char* message = parakeet_capi_last_error(context_.get());
			throw std::runtime_error(message ? message : "Parakeet stream feed failed");
		}
		const std::string delta(result);
		parakeet_capi_free_string(result);

		if (!delta.empty()) {
			transcript_ += delta;
			emit("interim", "\"text\":\"" + jsonEscape(trim(transcript_)) + "\"");
		}

		// Audio reaches STT only while Pi is listening or push-to-talk is armed,
		// so an EOB acknowledgement is still the user taking this conversation turn.
		if ((events & (kEventEou | kEventEob)) != 0) {
			emit("final", "\"text\":\"" + jsonEscape(trim(transcript_)) + "\"");
			transcript_.clear();
		}
	}

private:
	ContextPtr context_;
	StreamPtr stream_;
	std::string transcript_;
};

} // namespace

int main(int argc, char** argv) {
	if (argc != 2) {
		std::cerr << "usage: pi-voice-stt <parakeet-streaming-model.gguf>\n";
		return 2;
	}

	try {
		Worker worker(argv[1]);
		emit("ready", "\"sampleRate\":16000");

		while (true) {
			unsigned char header[5];
			if (!readExact(reinterpret_cast<char*>(header), sizeof(header))) break;
			const auto type = header[0];
			const auto payloadLength = decodeU32Le(header + 1);
			if (payloadLength > kMaxFrameBytes) throw std::runtime_error("input frame exceeds 1 MiB");

			std::vector<unsigned char> payload(payloadLength);
			if (payloadLength > 0 && !readExact(reinterpret_cast<char*>(payload.data()), payload.size())) break;

			if (type == kShutdown) break;
			if (type == kReset) {
				worker.reset();
				emit("reset");
				continue;
			}
			if (type == kAudioFrame) {
				worker.feed(payload);
				continue;
			}
			throw std::runtime_error("unknown input frame type " + std::to_string(type));
		}
		return 0;
	} catch (const std::exception& error) {
		emit("error", "\"message\":\"" + jsonEscape(error.what()) + "\"");
		std::cerr << "pi-voice-stt: " << error.what() << '\n';
		return 1;
	}
}
