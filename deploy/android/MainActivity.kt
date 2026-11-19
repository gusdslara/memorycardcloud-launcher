package __PACKAGE__

// Modelo aplicado por deploy/android-signing.mjs sobre o MainActivity.kt que o `tauri android init` gera
// (a pasta src-tauri/gen não vai para o git). __PACKAGE__ vem do "identifier" do tauri.conf.json.

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Barras do sistema transparentes com ícones claros (o app é escuro)
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)

    // O WebView não recebe as áreas do sistema (hora, wifi, bateria, barra de gestos, recorte da câmera):
    // sem isso o cabeçalho do app fica por baixo da barra de status e o banner do AdMob por cima da barra
    // de gestos. A área das barras fica na cor de fundo do app.
    window.decorView.setBackgroundColor(APP_BACKGROUND)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      // o teclado empurra o conteúdo para cima (campos de busca e formulários continuam visíveis)
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }

  private companion object {
    /** --night em src/lib/styles/tokens.css */
    val APP_BACKGROUND = Color.parseColor("#0e1330")
  }
}
