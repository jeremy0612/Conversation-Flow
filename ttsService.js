const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { TTS_SERVICE } = require("../core/constants/serviceEndpoints");
const websocketService = require("./websocketService");

// Hàm xử lý chuyển đổi text thành audio sử dụng TTS_SERVICE
async function generateSpeech(text, speakerId = 0, format = "wav") {
  try {
    console.log("=== TTS Service Debug ===");
    console.log("Text:", text);
    console.log("Speaker ID:", speakerId);
    console.log("Format:", format);
    console.log("TTS Service URL:", TTS_SERVICE);
    console.log("Gọi TTS service để chuyển Text thành Speech...");

    // Kiểm tra text có hợp lệ không
    if (!text || text.trim().length === 0) {
      console.error("Text không hợp lệ hoặc rỗng");
      throw new Error("Text không được để trống");
    }

    // Tạo request payload
    const payload = {
      text: text.trim(),
      speaker_id: parseInt(speakerId),
    };

    console.log("TTS Request payload:", payload);
    console.log("Sending request to:", `${TTS_SERVICE}/api/tts/stream`);

    // Gọi TTS service
    const response = await axios.post(
      `${TTS_SERVICE}/api/tts/stream`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
        },
        responseType: "stream", // Nhận response dưới dạng stream
        timeout: 30000, // 30 giây timeout
      }
    );

    console.log("TTS Response Status:", response.status);
    console.log("TTS Response Headers:", response.headers);

    // Tạo tên file unique
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const filename = `tts-${uniqueSuffix}.${format}`;
    const outputPath = path.join("data/tts", filename);

    // Đảm bảo thư mục data tồn tại
    if (!fs.existsSync("data/tts")) {
      fs.mkdirSync("data/tts", { recursive: true });
    }

    // Lưu audio stream vào file
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", () => {
        console.log("TTS audio saved to:", outputPath);
        resolve({
          filename: filename,
          path: outputPath,
          size: fs.statSync(outputPath).size,
        });
      });

      writer.on("error", (error) => {
        console.error("Error saving TTS audio:", error);
        reject(error);
      });
    });
  } catch (error) {
    console.error("=== TTS Service Error Details ===");
    console.error("Error message:", error.message);
    console.error("Error code:", error.code);
    console.error("Error response status:", error.response?.status);
    console.error("Error response status text:", error.response?.statusText);
    console.error("Error response data:", error.response?.data);
    console.error("Request URL:", error.config?.url);
    console.error("Request method:", error.config?.method);

    throw error;
  }
}

// Hàm tạo audio và trả về buffer (không lưu file)
async function generateSpeechBuffer(text, speakerId = 0) {
  try {
    console.log("=== TTS Service Buffer Debug ===");
    console.log("Text:", text);
    console.log("Speaker ID:", speakerId);
    console.log("TTS Service URL:", TTS_SERVICE);

    if (!text || text.trim().length === 0) {
      throw new Error("Text không được để trống");
    }

    const payload = {
      text: text.trim(),
      speaker_id: parseInt(speakerId),
    };

    const response = await axios.post(
      `${TTS_SERVICE}/api/tts/stream`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer", // Nhận response dưới dạng buffer
        timeout: 30000,
      }
    );

    console.log("TTS Response Status:", response.status);
    console.log("TTS Buffer Size:", response.data.length);

    return {
      buffer: Buffer.from(response.data),
      contentType: response.headers["content-type"] || "audio/wav",
      size: response.data.length,
    };
  } catch (error) {
    console.error("=== TTS Service Buffer Error ===");
    console.error("Error:", error.message);
    throw error;
  }
}

// Hàm tạo TTS và stream qua WebSocket
async function generateSpeechStream(text, speakerId = 0, sessionId = null) {
  try {
    console.log("=== TTS WebSocket Stream Debug ===");
    console.log("Text:", text);
    console.log("Speaker ID:", speakerId);
    console.log("Session ID:", sessionId);

    // Broadcast TTS start event
    websocketService.broadcastTTSStart({
      text: text,
      speakerId: speakerId,
      sessionId: sessionId,
    });

    // Kiểm tra text có hợp lệ không
    if (!text || text.trim().length === 0) {
      throw new Error("Text không được để trống");
    }

    // Tạo request payload
    const payload = {
      text: text.trim(),
      speaker_id: parseInt(speakerId),
    };

    console.log("Calling TTS service for streaming...");

    // Gọi TTS service
    const response = await axios.post(
      `${TTS_SERVICE}/api/tts/stream`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
        },
        responseType: "stream",
        timeout: 30000,
      }
    );

    console.log("TTS Response Status:", response.status);

    let totalSize = 0;
    let chunkCount = 0;

    // Stream audio chunks qua WebSocket
    response.data.on("data", (chunk) => {
      totalSize += chunk.length;
      chunkCount++;

      console.log(`Streaming chunk ${chunkCount}, size: ${chunk.length} bytes`);

      // Broadcast audio chunk qua WebSocket
      websocketService.broadcastTTSChunk(chunk, {
        chunkNumber: chunkCount,
        chunkSize: chunk.length,
        totalSize: totalSize,
        sessionId: sessionId,
        contentType: response.headers["content-type"] || "audio/wav",
      });
    });

    response.data.on("end", () => {
      console.log(
        `TTS streaming completed. Total: ${totalSize} bytes, ${chunkCount} chunks`
      );

      // Broadcast TTS end event
      websocketService.broadcastTTSEnd({
        totalSize: totalSize,
        totalChunks: chunkCount,
        sessionId: sessionId,
        completed: true,
      });
    });

    response.data.on("error", (error) => {
      console.error("TTS streaming error:", error);

      // Broadcast TTS error event
      websocketService.broadcast({
        type: "tts_error",
        error: error.message,
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
      });
    });

    return {
      success: true,
      message: "TTS streaming started",
      sessionId: sessionId,
      clientCount: websocketService.getClientCount(),
    };
  } catch (error) {
    console.error("TTS WebSocket Stream Error:", error.message);

    // Broadcast error
    websocketService.broadcast({
      type: "tts_error",
      error: error.message,
      sessionId: sessionId,
      timestamp: new Date().toISOString(),
    });

    throw error;
  }
}




// Hàm tạo TTS từng câu và stream qua WebSocket
async function generateSentenceStream(
  sentences,
  speakerId = 0,
  sessionId = null,
  clientId = null
) {
  try {
    console.log("=== TTS Sentence Stream Debug ===");
    console.log("Sentences:", sentences);
    console.log("Speaker ID:", speakerId);
    console.log("Session ID:", sessionId);
    console.log("Client ID:", clientId);

    // Gửi TTS start event
    if (clientId) {
      // Gửi tới client cụ thể
      websocketService.sendTTSStartToClient(clientId, {
        sentences: sentences,
        speakerId: speakerId,
        sessionId: sessionId,
      });
    } else {
      // Broadcast cho tất cả (backward compatibility)
      websocketService.broadcastTTSStart({
        sentences: sentences,
        speakerId: speakerId,
        sessionId: sessionId,
      });
    }

    let totalSentences = sentences.length;
    let completedSentences = 0;

    // Xử lý từng câu một
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      console.log(
        `Processing sentence ${i + 1}/${totalSentences}: ${sentence.substring(
          0,
          50
        )}...`
      );

      try {
        // Thay dấu chấm thành dấu phẩy, và thay "AI" thành "ây ai"
        const sentencesWithoutPeriod = sentence
          .replace(/\./g, ",")
          .replace(/\bAI\b/gi, "ây ai");

        console.log("Sentences without periods:", sentencesWithoutPeriod);
        // Tạo TTS cho câu này
        const audioResult = await generateSpeechBuffer(
          sentencesWithoutPeriod,
          speakerId
        );

        // Gửi sentence start
        if (clientId) {
          // Gửi tới client cụ thể
          websocketService.sendToClient(clientId, "sentence_start", {
            type: "sentence_start",
            sentenceIndex: i + 1,
            totalSentences: totalSentences,
            sentence: sentence,
            sessionId: sessionId,
          });
        } else {
          // Broadcast cho tất cả (backward compatibility)
          if (websocketService.io) {
            websocketService.io.of("/tts").emit("sentence_start", {
              type: "sentence_start",
              sentenceIndex: i + 1,
              totalSentences: totalSentences,
              sentence: sentence,
              sessionId: sessionId,
            });
          }
        }

        // Gửi audio buffer cho câu này
        if (clientId) {
          // Gửi tới client cụ thể
          websocketService.sendToClient(clientId, "sentence_audio", {
            type: "sentence_audio",
            sentenceIndex: i + 1,
            totalSentences: totalSentences,
            audioData: audioResult.buffer.toString("base64"),
            audioSize: audioResult.size,
            contentType: audioResult.contentType,
            sessionId: sessionId,
            sentence: sentence,
          });
        } else {
          // Broadcast cho tất cả (backward compatibility)
          if (websocketService.io) {
            websocketService.io.of("/tts").emit("sentence_audio", {
              type: "sentence_audio",
              sentenceIndex: i + 1,
              totalSentences: totalSentences,
              audioData: audioResult.buffer.toString("base64"),
              audioSize: audioResult.size,
              contentType: audioResult.contentType,
              sessionId: sessionId,
              sentence: sentence,
            });
          }
        }

        completedSentences++;
        console.log(
          `✅ Sentence ${i + 1} completed, audio size: ${
            audioResult.size
          } bytes`
        );

        // Delay nhỏ giữa các câu
        if (i < sentences.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500)); // Tăng delay lên 500ms
        }
      } catch (error) {
        console.error(`❌ Error processing sentence ${i + 1}:`, error);

        // Gửi error cho câu này
        if (clientId) {
          // Gửi tới client cụ thể
          websocketService.sendToClient(clientId, "sentence_error", {
            type: "sentence_error",
            sentenceIndex: i + 1,
            error: error.message,
            sessionId: sessionId,
          });
        } else {
          // Broadcast cho tất cả (backward compatibility)
          if (websocketService.io) {
            websocketService.io.of("/tts").emit("sentence_error", {
              type: "sentence_error",
              sentenceIndex: i + 1,
              error: error.message,
              sessionId: sessionId,
            });
          }
        }
      }
    }

    // Gửi TTS end event
    if (clientId) {
      // Gửi tới client cụ thể
      websocketService.sendTTSEndToClient(clientId, {
        totalSentences: totalSentences,
        completedSentences: completedSentences,
        sessionId: sessionId,
        completed: true,
      });
    } else {
      // Broadcast cho tất cả (backward compatibility)
      websocketService.broadcastTTSEnd({
        totalSentences: totalSentences,
        completedSentences: completedSentences,
        sessionId: sessionId,
        completed: true,
      });
    }

    console.log(
      `✅ Sentence streaming completed. ${completedSentences}/${totalSentences} sentences processed`
    );

    return {
      success: true,
      message: "Sentence streaming completed",
      sessionId: sessionId,
      totalSentences: totalSentences,
      completedSentences: completedSentences,
      clientCount: websocketService.getClientCount(),
    };
  } catch (error) {
    console.error("TTS Sentence Stream Error:", error.message);

    // Gửi error
    if (clientId) {
      // Gửi tới client cụ thể
      websocketService.sendTTSErrorToClient(clientId, {
        error: error.message,
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
      });
    } else {
      // Broadcast cho tất cả (backward compatibility)
      websocketService.broadcast({
        type: "tts_error",
        error: error.message,
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
      });
    }

    throw error;
  }
}


// Hàm tạo TTS từng câu và stream qua WebSocket — KHÔNG dùng sessionId
async function generateSentenceStreamNoSession(
  sentences,
  speakerId = 0,
  clientId = null
) {
  try {
    console.log("=== TTS Sentence Stream (NoSession) Debug ===");
    console.log("Sentences:", sentences);
    console.log("Speaker ID:", speakerId);
    console.log("Client ID:", clientId);

    // Gửi TTS start event (không kèm sessionId)
    if (clientId) {
      websocketService.sendTTSStartToClient(clientId, {
        sentences,
        speakerId,
      });
    } else {
      websocketService.broadcastTTSStart({
        sentences,
        speakerId,
      });
    }

    if (!Array.isArray(sentences) || sentences.length === 0) {
      throw new Error("Danh sách câu rỗng hoặc không hợp lệ");
    }

    let totalSentences = sentences.length;
    let completedSentences = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      console.log(
        `Processing sentence ${i + 1}/${totalSentences}: ${sentence.substring(0, 50)}...`
      );

      try {
        // Chuẩn hoá câu cho TTS
        const sentenceForTTS = sentence
          .replace(/\./g, ",")
          .replace(/\bAI\b/gi, "ây ai");

        const audioResult = await generateSpeechBuffer(
          sentenceForTTS,
          speakerId
        );

        // sentence_start (không kèm sessionId)
        if (clientId) {
          websocketService.sendToClient(clientId, "sentence_start", {
            type: "sentence_start",
            sentenceIndex: i + 1,
            totalSentences,
            sentence,
          });
        } else if (websocketService.io) {
          websocketService.io.of("/tts").emit("sentence_start", {
            type: "sentence_start",
            sentenceIndex: i + 1,
            totalSentences,
            sentence,
          });
        }

        // sentence_audio (không kèm sessionId)
        const payloadAudio = {
          type: "sentence_audio",
          sentenceIndex: i + 1,
          totalSentences,
          audioData: audioResult.buffer.toString("base64"),
          audioSize: audioResult.size,
          contentType: audioResult.contentType,
          sentence,
        };

        if (clientId) {
          websocketService.sendToClient(clientId, "sentence_audio", payloadAudio);
        } else if (websocketService.io) {
          websocketService.io.of("/tts").emit("sentence_audio", payloadAudio);
        }

        completedSentences++;
        console.log(`✅ Sentence ${i + 1} completed, audio size: ${audioResult.size} bytes`);

        if (i < sentences.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error(`❌ Error processing sentence ${i + 1}:`, error);

        const errPayload = {
          type: "sentence_error",
          sentenceIndex: i + 1,
          error: error.message,
        };

        if (clientId) {
          websocketService.sendToClient(clientId, "sentence_error", errPayload);
        } else if (websocketService.io) {
          websocketService.io.of("/tts").emit("sentence_error", errPayload);
        }
      }
    }

    // Gửi TTS end event (không kèm sessionId)
    const endMeta = {
      totalSentences,
      completedSentences,
      completed: true,
    };

    if (clientId) {
      websocketService.sendTTSEndToClient(clientId, endMeta);
    } else {
      websocketService.broadcastTTSEnd(endMeta);
    }

    console.log(
      `✅ Sentence streaming (NoSession) completed. ${completedSentences}/${totalSentences} sentences processed`
    );

    return {
      success: true,
      message: "Sentence streaming completed (no session)",
      totalSentences,
      completedSentences,
      clientCount: websocketService.getClientCount(),
    };
  } catch (error) {
    console.error("TTS Sentence Stream (NoSession) Error:", error.message);

    const errPayload = {
      type: "tts_error",
      error: error.message,
      timestamp: new Date().toISOString(),
    };

    if (clientId) {
      // Tránh dùng sendTTSErrorToClient (vì có trường sessionId); emit thủ công
      websocketService.sendToClient(clientId, "tts_error", errPayload);
    } else {
      websocketService.broadcast(errPayload);
    }

    throw error;
  }
}

module.exports = {
  generateSpeech,
  generateSpeechBuffer,
  generateSpeechStream,
  generateSentenceStream,
  generateSentenceStreamNoSession
};
