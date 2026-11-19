# The Tauri plugin class is created by reflection (tauri-android's consumer rules keep @TauriPlugin
# classes; this is a belt-and-braces rule for the release build with R8).
-keep class cloud.memorycard.webtab.WebTabPlugin { public <init>(...); public <methods>; }
-keep class cloud.memorycard.webtab.OpenArgs { *; }
