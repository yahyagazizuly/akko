// Puts the icon, the version info and the manifest (per-monitor DPI, modern controls) into Akko.exe.
// Only when building on Windows (the resource compiler comes with the Windows SDK); a cross-check from
// another system skips it.
fn main() {
    println!("cargo:rerun-if-changed=assets/akko.ico");
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") || !cfg!(windows) {
        return;
    }
    let mut r = winresource::WindowsResource::new();
    r.set_icon("assets/akko.ico");
    r.set("ProductName", "Akko");
    r.set("FileDescription", "Akko");
    r.set("CompanyName", "yahyagazizuly");
    r.set("LegalCopyright", "MIT License");
    r.set_manifest(
        r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency><dependentAssembly>
    <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
  </dependentAssembly></dependency>
  <application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>
    <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
    <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
  </windowsSettings></application>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application>
    <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
  </application></compatibility>
</assembly>"#,
    );
    r.compile().expect("resources");
}
