# TPT post-mortem stack walker for Windows builds

This program lets you rehash [The Powder Toy](https://github.com/The-Powder-Toy/The-Powder-Toy) crash logs created on Windows, annotating stack frame return addresses with source file names and line numbers.

## Dependencies

This program relies on [the MSDIA component](https://learn.microsoft.com/en-us/visualstudio/debugger/debug-interface-access/debug-interface-access-sdk). This component comes with [Visual Studio](https://visualstudio.microsoft.com/). The Meson option `dia_sdk_path` must point to the SDK directory, which has a directory named `include` in it. The default value of this Meson option is a good first approximation, but the correct value will vary depending on your Visual Studio installation.

## Building

[Install Meson](https://mesonbuild.com/Getting-meson.html) and build it like any Meson project, e.g. in a command prompt:

```batch
meson setup -Ddia_sdk_path="C:/path/to/msdia/sdk" build-debug
cd build-debug
meson compile
```

## Usage

Acquire the PDB file corresponding to the version of TPT the crash log originates from. The PDB files for official releases (including snapshots and betas) are available [on GitHub in the official repo](https://github.com/The-Powder-Toy/The-Powder-Toy/releases). Assuming it is named `powder.pdb`, and that you have a crash log named `crash.log`, run:

```batch
pmsw.exe powder.pdb < crash.log
```

The crash log will be printed back out, with return addresses annotated with source file names and line numbers.

## Troubleshooting

### CoCreateInstance failed: 80040154

You most likely need to register the MSDIA component. You can do this by running `regsvr32 msdia140.dll` (or newer versions of the DLL) as administrator. The DLL is located in the `bin` directory under the MSDIA SDK directory. Install the version that matches the architecture you built this program for.

### Main VA not yet available, cannot resolve VA

This means that the crash log originates from an unsupported version of TPT. There is nothing you can do to fix this.
