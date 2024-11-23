project('postmortem-stackwalk', 'cpp')

dia_sdk_path = get_option('dia_sdk_path')

executable(
	'pmsw',
	sources: 'pmsw.cpp',
	override_options: [
		'warning_level=3',
		'cpp_std=c++20',
	],
	include_directories: [
		join_paths(dia_sdk_path, 'include'),
	],
)
