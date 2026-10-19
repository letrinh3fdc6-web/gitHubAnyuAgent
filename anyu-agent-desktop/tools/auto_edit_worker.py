#!/usr/bin/env python3
"""Analyze media assets and render an AI-authored multi-track edit plan."""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except (AttributeError, OSError):
        pass

VIDEO_EXTS = {'.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'}
IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.apng'}
AUDIO_EXTS = {'.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.opus', '.wma'}
ASSET_EXTS = VIDEO_EXTS | IMAGE_EXTS | AUDIO_EXTS
MAX_ASSETS = 100
MAX_VISUAL_ASSETS = 50
MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024


def tool(name):
    found = shutil.which(name)
    if found:
        return found
    if os.name == 'nt':
        candidates = [
            Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft' / 'WinGet' / 'Links' / f'{name}.exe',
            Path(os.environ.get('ProgramFiles', '')) / 'ffmpeg' / 'bin' / f'{name}.exe',
        ]
        for candidate in candidates:
            if candidate.exists():
                return str(candidate)
    return ''


def run(cmd, timeout=600):
    return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)


def require_tool(name):
    value = tool(name)
    if not value:
        raise RuntimeError(f'{name} 未安装或不在 PATH 中')
    return value


def read_json(file_path):
    return json.loads(Path(file_path).read_text(encoding='utf-8-sig'))


def media_paths(values):
    found = []
    seen = set()
    for value in values:
        root = Path(value).expanduser().resolve()
        if not root.exists():
            raise RuntimeError(f'素材不存在：{root}')
        if root.is_file():
            candidates = [root]
        elif root.is_dir():
            candidates = (item for item in root.rglob('*') if item.is_file() and item.suffix.lower() in ASSET_EXTS)
        else:
            continue
        for item in candidates:
            if item.suffix.lower() not in ASSET_EXTS:
                continue
            resolved = item.resolve()
            key = str(resolved).casefold()
            if key not in seen:
                seen.add(key)
                found.append(resolved)
                if len(found) > MAX_ASSETS:
                    raise RuntimeError(f'单次最多分析 {MAX_ASSETS} 个媒体文件，请分批处理')
    if not found:
        raise RuntimeError('没有找到支持的视频、图片、动画或音频文件')
    total = sum(item.stat().st_size for item in found)
    if total > MAX_TOTAL_BYTES:
        raise RuntimeError('素材总大小超过 10 GB，请分批处理')
    return sorted(found, key=lambda item: str(item).casefold())


def probe(file_path):
    ffprobe = require_tool('ffprobe')
    result = run([ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(file_path)], timeout=60)
    if result.returncode:
        return {'error': result.stderr[-500:] or 'ffprobe 读取失败'}
    data = json.loads(result.stdout)
    fmt = data.get('format') or {}
    streams = data.get('streams') or []
    video = next((row for row in streams if row.get('codec_type') == 'video'), {})
    audio = next((row for row in streams if row.get('codec_type') == 'audio'), {})
    ext = file_path.suffix.lower()
    if ext in VIDEO_EXTS:
        kind = 'video'
    elif ext in IMAGE_EXTS and video and float(fmt.get('duration') or 0) > 0.15:
        kind = 'animation'
    elif ext in IMAGE_EXTS:
        kind = 'image'
    else:
        kind = 'audio'
    return {
        'kind': kind,
        'duration': float(fmt.get('duration') or video.get('duration') or 0),
        'width': video.get('width'), 'height': video.get('height'),
        'fps': video.get('r_frame_rate'), 'hasAudio': bool(audio),
        'videoCodec': video.get('codec_name'), 'audioCodec': audio.get('codec_name'),
        'sampleRate': audio.get('sample_rate'), 'channels': audio.get('channels'),
    }


def transcribe_audio(file_path, output_dir, has_audio):
    if not has_audio or os.name != 'nt':
        return {'status': 'unavailable', 'segments': []}
    ffmpeg = require_tool('ffmpeg')
    wav_path = output_dir / f'asr-{abs(hash(str(file_path))):x}.wav'
    converted = run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(file_path), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(wav_path)], timeout=180)
    if converted.returncode or not wav_path.exists():
        return {'status': 'conversion-failed', 'segments': []}
    powershell = shutil.which('powershell') or shutil.which('powershell.exe')
    if not powershell:
        return {'status': 'unavailable', 'segments': []}
    script = r'''
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine([Globalization.CultureInfo]::GetCultureInfo('zh-CN'))
$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$engine.SetInputToWaveFile($env:LETA_ASR_WAV)
$rows = @()
$cursor = 0
while ($true) {
  $recognized = $engine.Recognize([TimeSpan]::FromSeconds(4))
  if ($null -eq $recognized) { break }
  if ($recognized.Confidence -ge 0.42 -and -not [string]::IsNullOrWhiteSpace($recognized.Text)) {
    $offset = $cursor
    $length = 4
    try { $offset = [Math]::Max(0, $recognized.Audio.AudioPosition.TotalSeconds) } catch {}
    try { $length = [Math]::Max(0.3, $recognized.Audio.Duration.TotalSeconds) } catch {}
    $cursor = $offset + $length
    $rows += [PSCustomObject]@{ start = $offset; duration = $length; text = $recognized.Text.Trim(); confidence = [Math]::Round($recognized.Confidence, 3) }
  }
}
$engine.Dispose()
ConvertTo-Json -InputObject $rows -Compress -Depth 4
'''
    env = dict(os.environ)
    env['LETA_ASR_WAV'] = str(wav_path)
    try:
        result = subprocess.run([powershell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], capture_output=True, text=True, encoding='utf-8', errors='replace', env=env, timeout=90)
        payload = json.loads(result.stdout.strip().splitlines()[-1]) if result.stdout.strip() else []
        rows = payload if isinstance(payload, list) else [payload]
        segments = [{'start': max(0, float(row.get('start') or 0)), 'end': max(0.3, float(row.get('start') or 0) + float(row.get('duration') or 4)), 'text': str(row.get('text') or '').strip(), 'confidence': float(row.get('confidence') or 0)} for row in rows if isinstance(row, dict) and str(row.get('text') or '').strip()]
        return {'status': 'partial' if segments else 'no-confident-transcript', 'segments': segments}
    except Exception:
        return {'status': 'recognition-failed', 'segments': []}
    finally:
        try:
            wav_path.unlink()
        except OSError:
            pass


def extract_frame(ffmpeg, source, timestamp, destination, still=False):
    args = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y']
    if not still:
        args += ['-ss', f'{timestamp:.3f}']
    args += ['-i', str(source), '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-q:v', '4', str(destination)]
    result = run(args, timeout=90)
    if result.returncode or not destination.exists() or destination.stat().st_size < 100:
        return False
    return True


def make_contact_sheet(ffmpeg, source, timestamps, target, is_still):
    temp_frames = []
    for index, timestamp in enumerate(timestamps):
        frame = target.with_name(f'{target.stem}-{index + 1}.jpg')
        if extract_frame(ffmpeg, source, timestamp, frame, is_still):
            temp_frames.append((frame, timestamp))
    if not temp_frames:
        return []
    if len(temp_frames) == 1:
        shutil.move(str(temp_frames[0][0]), str(target))
    else:
        args = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y']
        for frame, _ in temp_frames:
            args += ['-i', str(frame)]
        filters = []
        names = []
        for index in range(len(temp_frames)):
            name = f'f{index}'
            names.append(f'[{name}]')
            filters.append(f'[{index}:v]scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[{name}]')
        filters.append(f'{"".join(names)}hstack=inputs={len(names)}[sheet]')
        args += ['-filter_complex', ';'.join(filters), '-map', '[sheet]', '-frames:v', '1', str(target)]
        result = run(args, timeout=90)
        if result.returncode or not target.exists():
            shutil.copy2(temp_frames[0][0], target)
    for frame, _ in temp_frames:
        try:
            frame.unlink()
        except OSError:
            pass
    return [{'path': str(target), 'at': round(timestamp, 3)} for _, timestamp in temp_frames]


def analyze(inputs_json, output_dir):
    ffmpeg = require_tool('ffmpeg')
    paths = media_paths(read_json(inputs_json))
    assets = []
    for index, file_path in enumerate(paths, start=1):
        info = probe(file_path)
        if info.get('error'):
            assets.append({'id': f'a{index:03d}', 'name': file_path.name, 'path': str(file_path), 'size': file_path.stat().st_size, **info})
            continue
        asset = {'id': f'a{index:03d}', 'name': file_path.name, 'path': str(file_path), 'size': file_path.stat().st_size, **info}
        asset['transcript'] = transcribe_audio(file_path, output_dir, info.get('hasAudio', False)) if info['kind'] in ('video', 'animation', 'audio') else {'status': 'not-applicable', 'segments': []}
        assets.append(asset)
    visual = [row for row in assets if row.get('kind') in ('video', 'image', 'animation') and not row.get('error')]
    if len(visual) > MAX_VISUAL_ASSETS:
        raise RuntimeError(f'本次有 {len(visual)} 个可视素材，超过模型一次分析上限 {MAX_VISUAL_ASSETS}；请分批提交')
    thumbnails = []
    for asset in visual:
        duration = max(0, float(asset.get('duration') or 0))
        is_still = asset['kind'] == 'image'
        if is_still:
            timestamps = [0]
        else:
            # 给模型足够的叙事上下文：短视频至少 5 帧，长视频按每 4 秒
            # 一个候选帧并保留首尾，避免只看到三个“抽象缩略图”。
            frame_count = max(5, min(18, int(math.ceil(duration / 4.0)) + 1))
            timestamps = sorted(set(round(min(duration, duration * index / max(frame_count - 1, 1)), 3) for index in range(frame_count)))
        sheet = output_dir / f"{asset['id']}-contact.jpg"
        frames = make_contact_sheet(ffmpeg, asset['path'], timestamps, sheet, is_still)
        if frames:
            thumbnails.append({'assetId': asset['id'], 'name': asset['name'], 'path': str(sheet), 'timestamps': [item['at'] for item in frames]})
        else:
            asset['visualAnalysis'] = '关键帧提取失败'
    analysis = {
        'version': 2, 'createdAt': time.time(), 'engine': 'ffprobe+ffmpeg',
        'assetCount': len(assets), 'assets': assets, 'thumbnails': thumbnails,
        'transcriptionEngine': 'Windows SAPI Chinese dictation (confidence >= 0.42)',
    }
    analysis_path = output_dir / 'analysis.json'
    analysis_path.write_text(json.dumps(analysis, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'ok': True, 'analysis': str(analysis_path), 'assetCount': len(assets), 'thumbnailCount': len(thumbnails), 'assets': assets, 'thumbnails': thumbnails}


def escape_ass(text):
    return str(text or '').replace('\\', r'\\').replace('{', r'\{').replace('}', r'\}').replace('\r', '').replace('\n', r'\N')


def ass_time(seconds):
    centiseconds = max(0, round(float(seconds or 0) * 100))
    hours, remainder = divmod(centiseconds, 360000)
    minutes, remainder = divmod(remainder, 6000)
    secs, cs = divmod(remainder, 100)
    return f'{hours}:{minutes:02d}:{secs:02d}.{cs:02d}'


def srt_time(seconds):
    milliseconds = max(0, round(float(seconds or 0) * 1000))
    hours, remainder = divmod(milliseconds, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    secs, ms = divmod(remainder, 1000)
    return f'{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}'


def write_subtitles(cues, output_dir, width, height):
    ass_path = output_dir / 'subtitles.ass'
    srt_path = output_dir / 'subtitles.srt'
    font_size = 52 if height >= 1500 else 46
    ass = [
        '[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {width}', f'PlayResY: {height}', 'WrapStyle: 2',
        '', '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        f'Style: Default,Microsoft YaHei,{font_size},&H00FFFFFF,&H0000D7FF,&HCC17212B,&H700B1822,-1,0,0,0,100,100,0,0,1,2.8,1.2,2,70,70,100,1',
        '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ]
    srt = []
    for index, cue in enumerate(cues, start=1):
        start = max(0, float(cue['start']))
        end = max(start + 0.15, float(cue['end']))
        text = str(cue['text']).strip()
        ass.append(f'Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{escape_ass(text)}')
        srt += [str(index), f'{srt_time(start)} --> {srt_time(end)}', text.replace('\r', '').replace('\n', ' '), '']
    ass_path.write_text('\n'.join(ass), encoding='utf-8-sig')
    srt_path.write_text('\n'.join(srt), encoding='utf-8-sig')
    return ass_path, srt_path


def synthesize_voiceover(text, output):
    text = str(text or '').strip()
    if not text or os.name != 'nt':
        return False
    powershell = shutil.which('powershell') or shutil.which('powershell.exe')
    if not powershell:
        return False
    script = r'''
Add-Type -AssemblyName System.Speech
$text = [Console]::In.ReadToEnd()
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }
$synth.Rate = 0
$synth.Volume = 100
$synth.SetOutputToWaveFile($env:LETA_VOICE_OUTPUT)
$synth.Speak($text)
$synth.Dispose()
'''
    env = dict(os.environ)
    env['LETA_VOICE_OUTPUT'] = str(output)
    try:
        result = subprocess.run([powershell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], input=text, capture_output=True, text=True, encoding='utf-8', errors='replace', env=env, timeout=180)
    except Exception:
        return False
    return result.returncode == 0 and Path(output).exists() and Path(output).stat().st_size > 1024


def filter_path(value):
    return str(value).replace('\\', '/').replace(':', r'\:').replace("'", r"'\''")


def atempo_filter(speed):
    """FFmpeg atempo accepts 0.5..2 per stage; split faster changes safely."""
    value = float(speed)
    parts = []
    while value > 2:
        parts.append('atempo=2')
        value /= 2
    while value < 0.5:
        parts.append('atempo=0.5')
        value /= 0.5
    parts.append(f'atempo={value:.4f}')
    return ','.join(parts)


def render(plan_path, output_dir):
    ffmpeg = require_tool('ffmpeg')
    ffprobe = require_tool('ffprobe')
    plan = read_json(plan_path)
    analysis_path = Path(plan.get('analysisPath') or (Path(plan_path).parent / 'analysis.json'))
    analysis = read_json(analysis_path)
    assets = {row['id']: row for row in analysis.get('assets', []) if row.get('id') and not row.get('error')}
    requested_clips = plan.get('clips') if isinstance(plan.get('clips'), list) else []
    if not requested_clips:
        raise RuntimeError('AI 剪辑计划没有 clips，拒绝机械回退')

    aspect = str(plan.get('aspect') or '9:16')
    dimensions = {'9:16': (1080, 1920), '16:9': (1920, 1080), '1:1': (1080, 1080)}
    width, height = dimensions.get(aspect, dimensions['9:16'])
    fps = max(24, min(60, int(plan.get('fps') or 30)))
    clips = []
    for index, raw in enumerate(requested_clips):
        asset = assets.get(str(raw.get('assetId') or ''))
        if not asset or asset.get('kind') not in ('video', 'image', 'animation'):
            raise RuntimeError(f'剪辑片段 {index + 1} 引用了不存在或不可视的素材')
        speed = min(3.0, max(0.5, float(raw.get('speed') or 1)))
        if asset['kind'] == 'image':
            source_start = 0.0
            source_end = float(raw.get('duration') or raw.get('end') or 3.0)
            source_end = min(30.0, max(0.6, source_end))
        else:
            source_start = max(0.0, float(raw.get('start') or 0))
            source_end = float(raw.get('end') or 0)
            media_duration = float(asset.get('duration') or 0)
            if media_duration > 0:
                source_end = min(source_end, media_duration)
            if not math.isfinite(source_end) or source_end <= source_start:
                raise RuntimeError(f'剪辑片段 {index + 1} 的源时间范围无效')
        duration = (source_end - source_start) / speed
        if duration < 0.6 or duration > 60:
            raise RuntimeError(f'剪辑片段 {index + 1} 时长超出 0.6 到 60 秒范围')
        clips.append({**raw, 'asset': asset, 'speed': speed, 'sourceStart': source_start, 'sourceEnd': source_end, 'duration': duration})

    transition_seconds = min(0.45, max(0.0, float(plan.get('transitionSeconds') or 0.25))) if len(clips) > 1 else 0
    transition_seconds = min(transition_seconds, min(item['duration'] for item in clips) * 0.35)
    total_duration = sum(item['duration'] for item in clips) - transition_seconds * max(0, len(clips) - 1)
    subtitles = plan.get('subtitles') if isinstance(plan.get('subtitles'), list) else []
    subtitles = [row for row in subtitles if isinstance(row, dict) and str(row.get('text') or '').strip()]
    if not subtitles:
        raise RuntimeError('AI 没有生成字幕，拒绝输出无字幕成片')
    valid_subtitles = []
    for row in subtitles:
        start = max(0, float(row.get('start') or 0))
        end = min(total_duration, float(row.get('end') or 0))
        if end > start + 0.12:
            valid_subtitles.append({'start': start, 'end': end, 'text': str(row['text']).strip()[:120]})
    if not valid_subtitles:
        raise RuntimeError('字幕时间范围没有落在成片时长内')

    output_dir.mkdir(parents=True, exist_ok=True)
    inputs = []
    for clip in clips:
        inputs.append({'path': Path(clip['asset']['path']), 'type': 'clip', 'still': clip['asset']['kind'] == 'image'})
    overlays = plan.get('overlays') if isinstance(plan.get('overlays'), list) else []
    normalized_overlays = []
    for row in overlays:
        asset = assets.get(str(row.get('assetId') or ''))
        if not asset or asset.get('kind') not in ('video', 'image', 'animation'):
            continue
        start = max(0, float(row.get('start') or 0))
        end = min(total_duration, float(row.get('end') or total_duration))
        if end <= start:
            continue
        index = len(inputs)
        inputs.append({'path': Path(asset['path']), 'type': 'overlay'})
        normalized_overlays.append({**row, 'asset': asset, 'inputIndex': index, 'start': start, 'end': end})

    audio_tracks = plan.get('audio') if isinstance(plan.get('audio'), list) else []
    normalized_audio = []
    for row in audio_tracks:
        asset = assets.get(str(row.get('assetId') or ''))
        if not asset or not asset.get('hasAudio'):
            continue
        start = max(0, float(row.get('start') or 0))
        end = min(total_duration, float(row.get('end') or total_duration))
        if end <= start:
            continue
        index = len(inputs)
        inputs.append({'path': Path(asset['path']), 'type': 'audio', 'loop': str(row.get('role') or '') == 'music'})
        normalized_audio.append({**row, 'asset': asset, 'inputIndex': index, 'start': start, 'end': end})
    source_audio_exists = any(bool(item['asset'].get('hasAudio')) for item in clips)
    voice_path = output_dir / 'voiceover.wav'
    voice_index = None
    subtitle_script = '。'.join(str(row.get('text') or '').strip() for row in valid_subtitles if str(row.get('text') or '').strip())
    voice_text = str(plan.get('voiceoverText') or '').strip()
    if not voice_text and not source_audio_exists and not normalized_audio and plan.get('readSubtitles', True) is not False:
        voice_text = subtitle_script[:6000]
    voiceover_added = bool(voice_text and synthesize_voiceover(voice_text, voice_path))
    if voice_text and not voiceover_added:
        raise RuntimeError('AI 已生成旁白，但本机中文语音合成失败')
    if voiceover_added:
        voice_index = len(inputs)
        inputs.append({'path': voice_path, 'type': 'audio'})
    any_audio = source_audio_exists or bool(normalized_audio) or voiceover_added
    if not any_audio:
        raise RuntimeError('素材没有可用音轨，AI 计划也未提供音乐或配音；拒绝生成静音视频')

    args = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y']
    for item in inputs:
        if item['type'] == 'overlay':
            args += ['-stream_loop', '-1', '-i', str(item['path'])]
        elif item['type'] == 'audio' and item.get('loop'):
            args += ['-stream_loop', '-1', '-i', str(item['path'])]
        elif item['type'] == 'clip' and item.get('still'):
            args += ['-loop', '1', '-framerate', str(fps), '-i', str(item['path'])]
        else:
            args += ['-i', str(item['path'])]

    filters = []
    video_labels = []
    audio_labels = []
    for index, clip in enumerate(clips):
        input_index = index
        source_duration = clip['sourceEnd'] - clip['sourceStart']
        filters.append(f'[{input_index}:v:0]trim=start={clip["sourceStart"]:.3f}:duration={source_duration:.3f},setpts=PTS-STARTPTS,setpts=PTS/{clip["speed"]:.4f},scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0x101820,fps={fps},format=yuv420p,setsar=1[v{index}]')
        video_labels.append(f'[v{index}]')
        if clip['asset'].get('hasAudio'):
            original_volume = min(1.5, max(0, float(clip.get('originalVolume', 0.72))))
            filters.append(f'[{input_index}:a:0]atrim=start={clip["sourceStart"]:.3f}:duration={source_duration:.3f},asetpts=PTS-STARTPTS,{atempo_filter(clip["speed"])},volume={original_volume:.3f},aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a{index}]')
        else:
            filters.append(f'anullsrc=r=48000:cl=stereo,atrim=duration={clip["duration"]:.3f}[a{index}]')
        audio_labels.append(f'[a{index}]')

    current_video = video_labels[0]
    current_audio = audio_labels[0]
    current_duration = clips[0]['duration']
    for index in range(1, len(clips)):
        transition = min(transition_seconds, clips[index - 1]['duration'] * 0.35, clips[index]['duration'] * 0.35)
        transition_name = str(clips[index].get('transition') or 'fade').lower()
        if transition_name not in {'fade', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circleopen', 'dissolve'}:
            transition_name = 'fade'
        next_video = f'[vx{index}]'
        next_audio = f'[ax{index}]'
        filters.append(f'{current_video}{video_labels[index]}xfade=transition={transition_name}:duration={transition:.3f}:offset={current_duration - transition:.3f}{next_video}')
        filters.append(f'{current_audio}{audio_labels[index]}acrossfade=d={transition:.3f}:c1=tri:c2=tri{next_audio}')
        current_video = next_video
        current_audio = next_audio
        current_duration += clips[index]['duration'] - transition

    for index, overlay in enumerate(normalized_overlays):
        input_index = overlay['inputIndex']
        scale = min(0.55, max(0.08, float(overlay.get('scale') or 0.24)))
        opacity = min(1.0, max(0.15, float(overlay.get('opacity') or 1)))
        label = f'ov{index}'
        filters.append(f'[{input_index}:v:0]scale=iw*{scale:.3f}:-2,format=rgba,colorchannelmixer=aa={opacity:.3f}[{label}]')
        position = str(overlay.get('position') or 'bottom-right')
        coords = {
            'top-left': '32:32', 'top-right': 'W-w-32:32', 'bottom-left': '32:H-h-110',
            'bottom-right': 'W-w-32:H-h-110', 'center': '(W-w)/2:(H-h)/2',
        }.get(position, 'W-w-32:H-h-110')
        next_video = f'[vo{index}]'
        filters.append(f'{current_video}[{label}]overlay=x={coords.split(":")[0]}:y={coords.split(":")[1]}:enable=\'between(t,{overlay["start"]:.3f},{overlay["end"]:.3f})\':eof_action=pass{next_video}')
        current_video = next_video

    mix_inputs = [current_audio]
    for index, track in enumerate(normalized_audio):
        input_index = track['inputIndex']
        delay = round(track['start'] * 1000)
        volume = min(2.0, max(0, float(track.get('volume') or (0.16 if track.get('role') == 'music' else 0.8))))
        label = f'music{index}'
        filters.append(f'[{input_index}:a:0]atrim=duration={track["end"] - track["start"]:.3f},asetpts=PTS-STARTPTS,volume={volume:.3f},adelay={delay}|{delay},apad,atrim=duration={total_duration:.3f},aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[{label}]')
        mix_inputs.append(f'[{label}]')
    if voice_index is not None:
        filters.append(f'[{voice_index}:a:0]atrim=duration={total_duration:.3f},asetpts=PTS-STARTPTS,volume=1.0,apad,atrim=duration={total_duration:.3f},aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[voice]')
        mix_inputs.append('[voice]')
    if len(mix_inputs) > 1:
        filters.append(f'{"".join(mix_inputs)}amix=inputs={len(mix_inputs)}:duration=longest:dropout_transition=2:normalize=0,alimiter=limit=0.95[aout]')
        final_audio = '[aout]'
    else:
        final_audio = current_audio

    ass_path, srt_path = write_subtitles(valid_subtitles, output_dir, width, height)
    sub_label = '[vsub]'
    filters.append(f"{current_video}subtitles=filename='{filter_path(ass_path)}'{sub_label}")
    output = output_dir / 'auto-edited.mp4'
    args += ['-filter_complex', ';'.join(filters), '-map', sub_label, '-map', final_audio, '-t', f'{total_duration:.3f}', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(output)]
    result = run(args, timeout=1800)
    if result.returncode or not output.exists() or output.stat().st_size < 1024:
        raise RuntimeError((result.stderr or 'FFmpeg 渲染失败')[-2000:])
    check = run([ffprobe, '-v', 'error', '-show_entries', 'stream=codec_type,duration', '-show_format', '-of', 'json', str(output)], timeout=60)
    if check.returncode:
        raise RuntimeError('成片校验失败：ffprobe 无法读取输出文件')
    streams = json.loads(check.stdout).get('streams', [])
    if not any(row.get('codec_type') == 'audio' for row in streams):
        raise RuntimeError('成片没有音轨，已拒绝标记成功')
    loudness = run([ffmpeg, '-hide_banner', '-i', str(output), '-vn', '-af', 'volumedetect', '-f', 'null', '-'], timeout=90)
    mean_match = re.search(r'mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB', loudness.stderr)
    if not mean_match:
        raise RuntimeError('成片音轨无法验证有效声音')
    mean_volume = float(mean_match.group(1))
    if mean_volume < -60:
        raise RuntimeError('成片音轨接近静音，已拒绝标记成功')
    return {
        'ok': True, 'output': str(output), 'analysis': str(analysis_path), 'plan': str(Path(plan_path).resolve()),
        'subtitles': str(srt_path), 'subtitleStyle': str(ass_path), 'duration': round(total_duration, 3),
        'clips': len(clips), 'assetsUsed': len({clip['asset']['id'] for clip in clips} | {row['asset']['id'] for row in normalized_overlays} | {row['asset']['id'] for row in normalized_audio}),
        'voiceoverAdded': voiceover_added, 'audioMeanVolumeDb': mean_volume,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=('analyze', 'render'), default='analyze')
    parser.add_argument('--inputs-json', default='')
    parser.add_argument('--plan', default='')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    if args.mode == 'analyze':
        if not args.inputs_json:
            raise RuntimeError('缺少素材列表')
        result = analyze(args.inputs_json, output_dir)
    else:
        if not args.plan:
            raise RuntimeError('缺少 AI 剪辑计划')
        result = render(args.plan, output_dir)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
