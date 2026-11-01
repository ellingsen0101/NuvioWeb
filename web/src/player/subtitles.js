// Parses sidecar subtitles into cues. The player draws them itself so timing offsets work the same
// everywhere, and mirrors them into a TextTrack for iPhone native fullscreen, where overlays can't show.
import { Backend } from "../services/backend.js";

function parseTimestamp(value) {
  const match = String(value).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!match) return null;
  const [, hours = "0", minutes, seconds, fraction] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(fraction.padEnd(3, "0")) / 1000;
}

function cleanMarkup(text) {
  return text
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/\\N/gi, "\n")
    .replace(/<\/?(?:i|b|u|font|c|v|ruby|rt|lang|span)[^>]*>/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function parseSrtOrVtt(source) {
  const cues = [];
  const blocks = source.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.length);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [startText, endText] = lines[timeIndex].split("-->");
    const start = parseTimestamp(startText);
    const end = parseTimestamp(endText);
    const text = cleanMarkup(lines.slice(timeIndex + 1).join("\n"));
    if (start == null || end == null || !text) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

function parseAss(source) {
  const cues = [];
  let textIndex = 9;
  let startIndex = 1;
  let endIndex = 2;
  for (const line of source.split(/\r?\n/)) {
    if (/^Format:/i.test(line) && line.includes("Text")) {
      const fields = line.slice(7).split(",").map((field) => field.trim().toLowerCase());
      textIndex = fields.indexOf("text");
      startIndex = fields.indexOf("start");
      endIndex = fields.indexOf("end");
    } else if (/^Dialogue:/i.test(line)) {
      const parts = line.slice(9).split(",");
      const start = parseTimestamp(parts[startIndex]);
      const end = parseTimestamp(parts[endIndex]);
      const text = cleanMarkup(parts.slice(textIndex).join(","));
      if (start != null && end != null && text) cues.push({ start, end, text });
    }
  }
  return cues;
}

export function parseSubtitles(source) {
  const text = String(source || "").replace(/^﻿/, "");
  const cues = /\[Script Info\]|^Dialogue:/im.test(text) ? parseAss(text) : parseSrtOrVtt(text);
  return cues.sort((a, b) => a.start - b.start);
}

function decode(buffer) {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  // Older subtitle files are often Windows-1252, which shows up as replacement characters.
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(buffer) : utf8;
}

export async function loadSubtitleCues(url, { signal } = {}) {
  let text;
  try {
    const response = await fetch(url, { signal, credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = decode(await response.arrayBuffer());
  } catch (error) {
    if (error?.name === "AbortError" || !Backend.isConnected()) throw error;
    text = await Backend.proxyText(url, { kind: "subtitle", signal });
  }
  const cues = parseSubtitles(text);
  if (!cues.length) throw new Error("This subtitle file has no readable cues");
  return cues;
}

export function cueAt(cues, seconds) {
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].end <= seconds) low = mid + 1;
    else high = mid - 1;
  }
  const active = [];
  for (let index = low; index < cues.length && cues[index].start <= seconds; index += 1) {
    if (cues[index].end > seconds) active.push(cues[index]);
  }
  return active;
}
