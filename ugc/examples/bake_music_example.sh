#!/bin/zsh
# trim the corrupted first frame, force 60fps, bake Golden Brown under the VO at -16 dB with a 2 s fade at the end
set -e
NB="${UGC_PROJECT:-$HOME/Neurobank UGC}";  # EXAMPLE: project folder, song and batch date belong to one format
 SONG="$NB/Components/Audios/golden-brown-instrumental.mp3"
OUT="$NB/Finished Videos/9-24"; mkdir -p "$OUT"
for v in "$@"; do
  src="$NB/Work/924/raw/$v.mp4"; dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src")
  fo=$(python3 -c "print(max(0,$dur-0.0167-2.0))")
  ffmpeg -v error -y -ss 0.0167 -i "$src" -i "$SONG" -filter_complex \
    "[1:a]volume=-16dB,afade=t=out:st=$fo:d=2[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]" \
    -map 0:v -map "[a]" -r 60 -c:v libx264 -preset medium -crf 19 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "$OUT/$v.mp4"
  ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate -show_entries format=duration -of csv=p=0 "$OUT/$v.mp4" | tr '\n' ' '; echo " <- $v"
done
