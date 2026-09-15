#!/usr/bin/env bash
# 生成测试素材：覆盖竖版/横版、25/30fps、无音轨、SAR 4:3、rotation=90 等参数组合
set -e
cd "$(dirname "$0")"
mkdir -p fixtures
FONT="${FIXTURE_FONT:-/System/Library/Fonts/Supplemental/Arial Unicode.ttf}"
[ -f "$FONT" ] || { echo "找不到字体 $FONT，用 FIXTURE_FONT 指定"; exit 1; }

# 母版封面：渐变底 + 标题 + 一个「旧集数」供擦除测试
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "gradients=s=1080x1920:c0=0x1b2a4a:c1=0x0d1220:nb_colors=2" -frames:v 1 \
  -vf "drawbox=x=0:y=1380:w=1080:h=420:color=0x101828:t=fill,\
drawtext=fontfile='$FONT':text='Sample Title':fontsize=96:fontcolor=white:x=(w-text_w)/2:y=1180,\
drawtext=fontfile='$FONT':text='08':fontsize=300:fontcolor=0xffd166:x=(w-text_w)/2:y=1420" \
  -pix_fmt rgb24 fixtures/master.png

mk() { # 文件名 宽 高 帧率 [额外参数...]
  local name="$1" W="$2" H="$3" FPS="$4"; shift 4
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=s=${W}x${H}:r=${FPS}:d=2" \
    -f lavfi -i "sine=f=440:r=44100:d=2" \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 50 \
    -c:a aac -b:a 128k -shortest "$@" "fixtures/$name"
}

mk "S01E03-1080p.mp4"  1080 1920 25
mk "S01E12-1080p.mp4"  1080 1920 30
mk "ep20_sar43.mp4"    1080 1920 25 -vf "setsar=4/3"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=s=1080x1920:r=25:d=2" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 50 -an fixtures/EP7_no_audio.mp4
mk "ep15_rotated.mp4"  1920 1080 25
ffmpeg -hide_banner -loglevel error -y -display_rotation 90 \
  -i fixtures/ep15_rotated.mp4 -c copy fixtures/.rot.mp4
mv fixtures/.rot.mp4 fixtures/ep15_rotated.mp4

# 音频同步基准：0.2s 静音 + 440Hz，用起振点校验 A/V 同步
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=s=1080x1920:r=25:d=2" \
  -f lavfi -i "aevalsrc='if(gte(t,0.2),0.5*sin(2*PI*440*t),0)':s=44100:d=2" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 50 -c:a aac -b:a 128k -shortest \
  fixtures/sync_probe_ep09.mp4

echo "测试素材已生成到 test/fixtures/"
