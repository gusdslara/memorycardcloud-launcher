# The Tauri plugin class is created by reflection (tauri-android's consumer rules keep @TauriPlugin
# classes; this is a belt-and-braces rule for the release build with R8).
-keep class cloud.memorycard.admob.AdMobPlugin { public <init>(...); public <methods>; }
-keep class cloud.memorycard.admob.InitializeArgs { *; }
-keep class cloud.memorycard.admob.AdUnitArgs { *; }

# O play-services-ads traz o WorkManager, que cria o banco (Room) por reflexão pelo nome "WorkDatabase_Impl".
# Sem estas regras o R8 do release remove a classe e o app fecha ao abrir:
# "Failed to create an instance of androidx.work.impl.WorkDatabase" (InitializationProvider).
-keep class * extends androidx.room.RoomDatabase { <init>(); }
-keep class androidx.work.impl.WorkDatabase_Impl { *; }
-keep class androidx.work.** { *; }
