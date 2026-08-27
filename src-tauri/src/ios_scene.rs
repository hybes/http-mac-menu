// iOS 26 turned UIScene adoption from advice into a launch requirement: UIKit
// kills any app built against that SDK which never answers
// `-application:configurationForConnectingSceneSession:options:`.
//
// tao installs that method for us, but only when the Info.plist says
// `UIApplicationSupportsMultipleScenes` (set in `gen/apple/project.yml`), and
// tao 0.35 hands UIKit a `UISceneConfiguration` it has already released — so
// the app segfaults inside `objc_retain` the moment the first scene connects.
// Upstream fixed it in tao 0.37 by returning the configuration autoreleased,
// but tauri-runtime-wry 2.11 still pins tao 0.35, so put a correct
// implementation in its place here.
//
// The swap has to land after `EventLoop::new` registers `AppDelegate` and
// before `EventLoop::run` calls `UIApplicationMain`. Tauri's `setup` hook is
// too late: UIKit must connect its first scene before that hook can run.
//
// Delete this module once tauri-runtime-wry depends on tao 0.36 or newer.

use std::ffi::CStr;
use std::ptr;
use std::sync::atomic::{AtomicPtr, Ordering};

use objc2::ffi::class_replaceMethod;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel};
use objc2_foundation::NSString;

const APP_DELEGATE: &CStr = c"AppDelegate";
const SCENE_DELEGATE: &CStr = c"TaoSceneDelegate";
const SCENE_CONFIGURATION: &CStr = c"UISceneConfiguration";
/// Must match UISceneConfigurationName in gen/apple/project.yml.
const CONFIGURATION_NAME: &str = "TaoScene";
/// Objective-C signature: object return, then self, _cmd and three objects.
const SIGNATURE: &CStr = c"@@:@@@";

type SceneConfigFn = unsafe extern "C-unwind" fn(
    *mut AnyObject,
    Sel,
    *mut AnyObject,
    *mut AnyObject,
    *mut AnyObject,
) -> *mut AnyObject;

/// tao's own implementation, kept so the replacement can still call it.
static ORIGINAL: AtomicPtr<()> = AtomicPtr::new(ptr::null_mut());

/// Returns the configuration UIKit asked for, at +0 like every other
/// `+someClassWithThing:` method — UIKit retains it itself.
extern "C-unwind" fn configuration_for_connecting_scene_session(
    this: *mut AnyObject,
    cmd: Sel,
    application: *mut AnyObject,
    session: *mut AnyObject,
    options: *mut AnyObject,
) -> *mut AnyObject {
    // objc2 only registers `TaoSceneDelegate` the first time tao asks for the
    // class, and tao only asks for it in the method being replaced here.
    // Calling through keeps that registration happening; the value it returns
    // is the freed pointer this module exists to avoid, so it is dropped
    // without ever being dereferenced.
    let original = ORIGINAL.load(Ordering::Relaxed);
    if !original.is_null() {
        let original: SceneConfigFn = unsafe { std::mem::transmute(original) };
        let _ = unsafe { original(this, cmd, application, session, options) };
    }

    unsafe {
        // Keep the role of the session that is connecting rather than assuming
        // a window scene, so external displays still get their own.
        let role: *mut AnyObject = msg_send![session, role];
        let class = AnyClass::get(SCENE_CONFIGURATION).expect("UISceneConfiguration");
        // The same name the Info.plist declares, so UIKit can resolve the
        // delegate class from the scene manifest rather than guessing.
        let name = NSString::from_str(CONFIGURATION_NAME);
        let config: *mut AnyObject =
            msg_send![class, configurationWithName: &*name, sessionRole: role];
        if let Some(delegate) = AnyClass::get(SCENE_DELEGATE) {
            let _: () = msg_send![config, setDelegateClass: delegate];
        }
        config
    }
}

pub fn install() -> Result<(), String> {
    let Some(delegate) = AnyClass::get(APP_DELEGATE) else {
        return Err(format!("{APP_DELEGATE:?} is not registered"));
    };
    if AnyClass::get(SCENE_CONFIGURATION).is_none() {
        return Err(format!("{SCENE_CONFIGURATION:?} is unavailable"));
    }

    let replacement: SceneConfigFn = configuration_for_connecting_scene_session;
    // SAFETY: the replacement takes tao's own argument list and returns an
    // object, which is what `SIGNATURE` describes.
    let previous = unsafe {
        class_replaceMethod(
            (delegate as *const AnyClass).cast_mut(),
            sel!(application:configurationForConnectingSceneSession:options:),
            std::mem::transmute::<SceneConfigFn, Imp>(replacement),
            SIGNATURE.as_ptr(),
        )
    };

    match previous {
        Some(original) => {
            ORIGINAL.store(original as *mut (), Ordering::Relaxed);
            Ok(())
        }
        // tao skips the method unless the scene manifest opts in, so its
        // absence means the Info.plist and this fix have drifted apart.
        None => Err(
            "tao did not install a scene configuration method — check that \
             UIApplicationSupportsMultipleScenes is true in Info.plist"
                .into(),
        ),
    }
}
