package com.flowstate

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Pass null to super.onCreate to DROP any saved instance state. react-native-screens
   * throws "Screen fragments should never be restored" when Android recreates this
   * Activity from saved state (which it does after the app is backgrounded long
   * enough -- e.g. while analysis runs with the screen locked). That crash killed the
   * whole process, taking the analysis foreground service down with it. Discarding the
   * saved state makes RN rebuild the screen tree fresh instead of restoring fragments.
   * See react-native-screens issue #17.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "flowstate"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
