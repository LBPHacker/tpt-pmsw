#define WIN32_LEAN_AND_MEAN
#include "dia2.h"

#include <iostream>
#include <optional>
#include <sstream>
#include <string_view>
#include <utility>
#include <vector>

#define STRINGIFY2(x) #x
#define STRINGIFY(x) STRINGIFY2(x)

namespace
{
	template<class ...Args> 
	std::string Str(Args &&...args)
	{
		std::ostringstream ss;
		auto [[maybe_unused]] unused = std::initializer_list<int>{ (ss << args, 0)... };
		return ss.str();
	}

	template<class ...Args> 
	void Die(Args &&...args)
	{
		std::cerr << (Str(std::forward<Args>(args)...) + "\n") << std::flush;
		std::exit(1);
	}

	template<class ...Args> 
	void Log(Args &&...args)
	{
		std::cerr << (Str(std::forward<Args>(args)...) + "\n") << std::flush;
	}

	std::string WinNarrow(std::wstring_view source)
	{
		if (!source.size())
		{
			return {};
		}
		int bufferSize = WideCharToMultiByte(CP_UTF8, 0, source.data(), int(source.size()), nullptr, 0, nullptr, nullptr);
		if (!bufferSize)
		{
			Die("WideCharToMultiByte failed");
		}
		std::string output(bufferSize, 0);
		if (!WideCharToMultiByte(CP_UTF8, 0, source.data(), int(source.size()), output.data(), bufferSize, nullptr, nullptr))
		{
			Die("WideCharToMultiByte failed");
		}
		return output;
	}

	std::wstring WinWiden(std::string_view source)
	{
		if (!source.size())
		{
			return {};
		}
		int bufferSize = MultiByteToWideChar(CP_UTF8, 0, source.data(), int(source.size()), nullptr, 0);
		if (!bufferSize)
		{
			Die("MultiByteToWideChar failed");
		}
		std::wstring output(bufferSize, 0);
		if (!MultiByteToWideChar(CP_UTF8, 0, source.data(), int(source.size()), output.data(), bufferSize))
		{
			Die("MultiByteToWideChar failed");
		}
		return output;
	}

	template<class Func>
	class Defer
	{
		Func func;

	public:
		Defer(Func &&newFunc) : func(std::forward<Func>(newFunc))
		{
		}

		Defer(const Defer &) = delete;
		Defer &operator =(const Defer &) = delete;

		~Defer()
		{
			func();
		}
	};

	void XcoAssert(HRESULT hr, const char *what)
	{
		if (!SUCCEEDED(hr))
		{
			Die(what, " failed: ", std::hex, hr, "/", GetLastError());
		}
	}
#define XcoAssert(x) XcoAssert(x, __FILE__ ":" STRINGIFY(__LINE__) ": " #x)

	DWORD GetRva(IDiaSymbol *global, std::string_view symbolName)
	{
		IDiaEnumSymbols *symbols{};
		XcoAssert(global->findChildren(SymTagFunction, WinWiden(symbolName).c_str(), nsRegularExpression, &symbols));
		Defer releaseSymbols([symbols]() {
			symbols->Release();
		});
		int found = 0;
		DWORD rva{};
		while (true)
		{
			IDiaSymbol *symbol{};
			ULONG fetched{};
			XcoAssert(symbols->Next(1, &symbol, &fetched));
			if (!fetched)
			{
				break;
			}
			Defer releaseSymbol([symbol]() {
				symbol->Release();
			});
			found += 1;
			if (found > 1)
			{
				Die("multiple symbols named ", symbolName, " found");
			}
			XcoAssert(symbol->get_relativeVirtualAddress(&rva));
		}
		if (!found)
		{
			Die("no symbol named ", symbolName, " found");
		}
		return rva;
	}

	ULONGLONG ParseVa(std::string str, const char *what)
	{
		ULONGLONG va{};
		std::istringstream ss(str);
		if (str.starts_with("0x") || str.starts_with("0X"))
		{
			ss >> std::hex;
		}
		ss >> va;
		if (!ss)
		{
			Die("failed to parse ", what);
		}
		return va;
	}
}

int wmain(int argc, wchar_t *argv[])
{
	if (argc < 2)
	{
		Die("need a pdb");
	}

	XcoAssert(CoInitialize(nullptr));
	Defer coUninit([]() {
		CoUninitialize();
	});

	IDiaDataSource *dataSource{};
	XcoAssert(CoCreateInstance(__uuidof(DiaSource), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IDiaDataSource), reinterpret_cast<void **>(&dataSource)));
	Defer releaseDataSource([dataSource]() {
		dataSource->Release();
	});
	XcoAssert(dataSource->loadDataFromPdb(argv[1]));

	IDiaSession *session{};
	XcoAssert(dataSource->openSession(&session));
	Defer releaseSession([session]() {
		session->Release();
	});

	IDiaSymbol *global{};
	XcoAssert(session->get_globalScope(&global));
	Defer releaseGlobal([global]() {
		global->Release();
	});

	std::optional<ULONGLONG> mainVa;
	if (argc > 2)
	{
		mainVa = ParseVa(WinNarrow(argv[2]), "forced Main VA");
	}

	auto mainRva = GetRva(global, "Main");
	auto resolveVa = [session, &mainVa, &mainRva](ULONGLONG va) -> std::string {
		if (!mainVa)
		{
			Die("Main VA not yet available, cannot resolve VA");
		}
		auto rva = DWORD(LONGLONG(va) - (LONGLONG(*mainVa) - LONGLONG(mainRva)));
		IDiaEnumLineNumbers *lineNumbers{};
		XcoAssert(session->findLinesByRVA(rva, 1, &lineNumbers));
		Defer releaseLineNumbers([lineNumbers]() {
			lineNumbers->Release();
		});
		int found = 0;
		DWORD lineIndex;
		std::string name;
		while (true)
		{
			IDiaLineNumber *lineNumber{};
			ULONG fetched{};
			XcoAssert(lineNumbers->Next(1, &lineNumber, &fetched));
			if (!fetched)
			{
				break;
			}
			Defer releaseLineNumber([lineNumber]() {
				lineNumber->Release();
			});
			found += 1;
			if (found > 1)
			{
				Die("multiple line numbers found");
			}
			XcoAssert(lineNumber->get_lineNumber(&lineIndex));

			IDiaSourceFile *sourceFile{};
			XcoAssert(lineNumber->get_sourceFile(&sourceFile));
			Defer releaseSourceFile([sourceFile]() {
				sourceFile->Release();
			});

			BSTR sourceName;
			XcoAssert(sourceFile->get_fileName(&sourceName));
			Defer freeSourceName([&sourceName]() {
				SysFreeString(sourceName);
			});
			name = WinNarrow(static_cast<const wchar_t *>(sourceName));
		}
		if (!found)
		{
			return "???";
		}
		return Str(name, ":", lineIndex);
	};

	std::optional<std::string> version;
	std::optional<std::string> tag;
	std::string line;
	while (std::getline(std::cin, line))
	{
		if (!tag)
		{
			static const std::string tagC = "Tag: ";
			auto pos = line.find(tagC);
			if (pos != line.npos)
			{
				tag = line.substr(pos + tagC.size());
			}
		}
		if (!version)
		{
			static const std::string versionC = "Version: ";
			auto pos = line.find(versionC);
			if (pos != line.npos)
			{
				version = line.substr(pos + versionC.size());
			}
		}
		if (!mainVa)
		{
			static const std::string mainIsAt = "Main is at ";
			auto pos = line.find(mainIsAt);
			if (pos != line.npos)
			{
				mainVa = ParseVa(line.substr(pos + mainIsAt.size()), "Main VA");
			}
		}
		if (line.size() && line.back() == ']')
		{
			auto i = int(line.size()) - 2;
			while (i >= 0 && line[i] != '[')
			{
				i -= 1;
			}
			if (i >= 0 && line[i] == '[')
			{
				auto va = ParseVa(line.substr(i + 1, int(line.size()) - i - 2), "mid-trace VA");
				if (!mainVa && tag && version)
				{
					struct TagOverride
					{
						std::string version;
						std::string tag;
						ULONGLONG stackTraceVaDiff;
					};
					static const std::vector<TagOverride> tagOverrides = {
						{ "98.2.365 X86_64-WINDOWS-MSVC LUACONSOLE HTTPS", "e371d63", 0x146 },
					};
					for (auto &tagOverride : tagOverrides)
					{
						if (tagOverride.version == *version && tagOverride.tag == *tag)
						{
							mainRva = GetRva(global, "Platform::StackTrace");
							mainVa = va - tagOverride.stackTraceVaDiff;
						}
					}
				}
				auto sourceLine = resolveVa(va);
				line = Str(line.substr(0, int(line.size()) - 1), " @ ", sourceLine, "]");
			}
		}
		std::cout << line << std::endl;
	}

	return 0;
}
