import { Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";

interface PluginSettings {
	includeFolders: string[];
	useHeader: boolean;
	useFirstLine: boolean;
	isTitleHidden: boolean;
	supportYAML: boolean;
	includeEmojis: boolean;
	charCount: number;
	checkInterval: number;
	skipNamedFiles: boolean; // 如果文件名已经存在或者文件不是未命名，就不修改文件名
}

const DEFAULT_SETTINGS: PluginSettings = {
	includeFolders: [],
	useHeader: true,
	useFirstLine: false,
	isTitleHidden: true,
	supportYAML: true,
	includeEmojis: true,
	charCount: 50,
	checkInterval: 500,
	skipNamedFiles: false, // 默认关闭，即默认情况下会重命名所有文件
};

// Global variables for "Rename all files" setting
let renamedFileCount = 0;
let tempNewPaths: string[] = [];

// Variables for debounce
let onTimeout = true;
let timeout: NodeJS.Timeout;
let previousFile: string;

function inTargetFolder(file: TFile, settings: PluginSettings): boolean {
	// 如果用户没有选择目标文件夹，则对所有文件生效
	if (settings.includeFolders.length === 0) return true;

	// 检查文件夹是否在目标文件夹列表中
	if (settings.includeFolders.includes(file.parent?.path as string))
		return true;

	return false; // 如果所有检查都不通过，则返回 false
}

export default class AutoFilename extends Plugin {
	settings: PluginSettings;

	// Function for renaming files
	async renameFile(file: TFile, noDelay = false): Promise<void> {
		if (!inTargetFolder(file, this.settings)) return; // Return if file is not within the target folder/s
		
		// 如果开启了 skipNamedFiles 选项，检查文件是否已经是命名文件，如果是则不需要重命名
		// 未命名文件通常以"Untitled"开头或没有实际内容
		if (this.settings.skipNamedFiles) {
			const isUntitledFile = file.basename.startsWith("Untitled") || file.basename === "";
			if (!isUntitledFile) return; // 如果不是未命名文件，则无需重命名
		}

		// Debounce to avoid performance issues if noDelay is disabled or checkInterval is 0
		if (noDelay === false) {
			if (onTimeout) {
				// Clear timeout only if renameFile is called on the same file.
				if (previousFile == file.path) {
					clearTimeout(timeout);
				}

				previousFile = file.path;

				timeout = setTimeout(() => {
					onTimeout = false;
					this.renameFile(file);
				}, this.settings.checkInterval);

				return;
			}

			onTimeout = true;
		}

		let content: string = await this.app.vault.cachedRead(file);

		// Supports YAML depending on user preference
		if (this.settings.supportYAML && content.startsWith("---")) {
			const index = content.indexOf("---", 3); // returns -1 if none
			if (index != -1) content = content.slice(index + 3).trimStart(); // Add 3 to cover "---" || Cleanup white spaces and newlines at start
		}

		// Use the header as filename depending on user preference
		if (this.settings.useHeader && content[0] == "#") {
			const headerArr: string[] = [
				"# ",
				"## ",
				"### ",
				"#### ",
				"##### ",
				"###### ",
			];
			for (let i = 0; i < headerArr.length; i++) {
				if (content.startsWith(headerArr[i])) {
					const index = content.indexOf("\n");
					if (index != -1) content = content.slice(i + 2, index);
					break;
				}
			}
		}

		const illegalChars = '\\/:*?"<>|#^[]'; // Characters that should be avoided in filenames
		const illegalNames: string[] = [
			"CON",
			"PRN",
			"AUX",
			"NUL",
			"COM1",
			"COM2",
			"COM3",
			"COM4",
			"COM5",
			"COM6",
			"COM7",
			"COM8",
			"COM9",
			"COM0",
			"LPT1",
			"LPT2",
			"LPT3",
			"LPT4",
			"LPT5",
			"LPT6",
			"LPT7",
			"LPT8",
			"LPT9",
			"LPT0",
		]; // Special filenames that are illegal in some OSs
		let newFileName = "";

		// Takes the first n characters of the file and uses it as part of the filename.
		for (let i = 0; i < content.length; i++) {
			// Adds "..." after the last character if file characters > n
			if (i >= Number(this.settings.charCount)) {
				newFileName = newFileName.trimEnd();
				newFileName += "...";
				break;
			}
			const char = content[i];

			if (char === "\n") {
				// Ignore succeeding lines of text when determining filename depending on user preference.
				if (this.settings.useFirstLine) {
					newFileName = newFileName.trimEnd();
					newFileName += "..."; // Adds "..." at the end to indicate there might be more text.
					break;
				}
			}

			// Avoid illegal characters in filenames
			if (!illegalChars.includes(char)) newFileName += char;
		}

		// Remove emojis as set by user
		if (!this.settings.includeEmojis) {
			newFileName = newFileName.replace(
				/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g,
				"",
			);
		}

		newFileName = newFileName
			.trim() // Trim white spaces
			.replace(/\s+/g, " "); // Replace consecutive whitespace characters with a space

		// Remove all leading "." to avoid naming issues.
		while (newFileName[0] == ".") {
			newFileName = newFileName.slice(1);
		}

		// Change to Untitled if newFileName outputs to nothing, or if it matches any of the illegal names.
		const isIllegalName =
			newFileName === "" ||
			illegalNames.includes(newFileName.toUpperCase());
		if (isIllegalName) newFileName = "Untitled";

		const parentPath =
			file.parent?.path === "/" ? "" : file.parent?.path + "/";

		let newPath = `${parentPath}${newFileName}.md`;

		// Duplicate checker: If file exists or newPath is in tempNewPaths, enter loop.
		let counter = 1;
		let fileExists: boolean =
			this.app.vault.getAbstractFileByPath(newPath) != null;
		while (fileExists || tempNewPaths.includes(newPath)) {
			// 只有在文件名完全相同且不是未命名文件时才跳过重命名
			if (file.path == newPath && !file.basename.startsWith("Untitled") && file.basename !== "") {
				return; // No need to rename if new filename == old filename and file is not untitled
			}
			counter += 1;
			newPath = `${parentPath}${newFileName} (${counter}).md`; // Adds (2), (3), (...) to avoid filename duplicates similar to windows.
			fileExists = this.app.vault.getAbstractFileByPath(newPath) != null;
		}

		// Populate tempNewPaths if noDelay is enabled to avoid duplicate bugs
		if (noDelay) {
			tempNewPaths.push(newPath);
		}

		// Rename file and increment renamedFileCount
		await this.app.fileManager.renameFile(file, newPath);
		renamedFileCount += 1;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new AutoFilenameSettings(this.app, this));

		// 监听文件创建事件 - 当新文件被创建时触发重命名
		this.registerEvent(
			this.app.vault.on("create", (abstractFile) => {
				if (abstractFile instanceof TFile) {
					// 对于新创建的文件，我们只在它是空文件或"Untitled"文件时才重命名
					// 使用setTimeout确保文件内容已经完全初始化
					setTimeout(async () => {
						const content = await this.app.vault.read(abstractFile);
						// 如果文件内容为空或基本上是空的，我们等待内容添加后再重命名
						if (content.trim().length === 0) {
							// 文件是空的，我们设置一个监听器来等待内容变化
							const contentCheckInterval = setInterval(async () => {
								const updatedContent = await this.app.vault.read(abstractFile);
								if (updatedContent.trim().length > 0) {
									// 内容已添加，执行重命名
									clearInterval(contentCheckInterval);
									this.renameFile(abstractFile, true); // 使用 noDelay=true 立即重命名
								}
							}, 300); // 每300ms检查一次，直到有内容为止，最多检查10次
							
							// 设置超时，防止无限期检查
							setTimeout(() => {
								clearInterval(contentCheckInterval);
							}, 10000); // 10秒后停止检查
						} else {
							// 文件已经有内容，直接重命名
							this.renameFile(abstractFile, true);
						}
					}, 100); // 延迟100ms确保文件完全创建
				}
			}),
		);

		// 添加右键菜单项
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				// 添加"使用选中文本作为文件名"菜单项
				menu.addItem((item) => {
					item
						.setTitle("使用选中文本作为文件名")
						.setIcon("file-plus")
						.onClick(async () => {
							// 获取当前编辑器中的选中文本
							const selectedText = editor.getSelection();
							if (!selectedText) {
								new Notice("请先选择要作为文件名的文本");
								return;
							}
							
							// 获取当前文件
							const file = view.file;
							if (!file) {
								new Notice("无法获取当前文件");
								return;
							}
							
							// 处理文件名，移除非法字符
							const illegalChars = '\\/:*?"<>|#^[]';
							let newFileName = selectedText;
							
							// 移除非法字符
							for (const char of illegalChars) {
								newFileName = newFileName.replace(new RegExp('\\' + char, 'g'), '');
							}
							
							// 处理空白字符
							newFileName = newFileName
								.trim()
								.replace(/\s+/g, " ");
							
							// 如果文件名为空，则使用默认名称
							if (newFileName === "") {
								newFileName = "Untitled";
							}
							
							// 获取文件路径
							const parentPath = file.parent?.path === "/" ? "" : file.parent?.path + "/";
							let newPath = `${parentPath}${newFileName}.md`;
							
							// 检查文件是否已存在
							let counter = 1;
							let fileExists = this.app.vault.getAbstractFileByPath(newPath) != null;
							while (fileExists) {
								if (file.path == newPath) {
									new Notice("文件名已经是当前选中的文本");
									return;
								}
								counter += 1;
								newPath = `${parentPath}${newFileName} (${counter}).md`;
								fileExists = this.app.vault.getAbstractFileByPath(newPath) != null;
							}
							
							// 重命名文件
							try {
								await this.app.fileManager.renameFile(file, newPath);
								new Notice(`文件已重命名为: ${newFileName}`);
							} catch (error) {
								new Notice(`重命名失败: ${error}`);
							}
						});
				});
			}),
		);

		// Triggers when a file is opened.
		// Used for "Hide inline title for target folder" setting.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!file) return;
				if (!document.body.classList.contains("show-inline-title"))
					return;

				const shouldHide =
					this.settings.isTitleHidden &&
					inTargetFolder(file, this.settings);

				const target = document
					.querySelector(".workspace-leaf.mod-active")
					?.querySelector(".inline-title");
				if (!target) return;
				const customCss = "hide-inline-title";
				if (shouldHide && !target.classList.contains(customCss)) {
					target.classList.add(customCss);
				}
				if (!shouldHide && target.classList.contains(customCss)) {
					target.classList.remove(customCss);
				}
			}),
		);
	}
}

class AutoFilenameSettings extends PluginSettingTab {
	plugin: AutoFilename;

	display(): void {
		this.containerEl.empty();

		// Setting 1
		new Setting(this.containerEl)
			.setName("Include")
			.setDesc(
				"Folder paths where Auto Filename would auto rename files. Separate by new line. Case sensitive.",
			)
			.addTextArea((text) => {
				text.setPlaceholder("/\nfolder\nfolder/subfolder")
					.setValue(this.plugin.settings.includeFolders.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.includeFolders = value.split("\n");
						await this.plugin.saveSettings();
					});
				text.inputEl.cols = 28;
				text.inputEl.rows = 4;
			});

		// Setting 2
		new Setting(this.containerEl)
			.setName("Use the header as filename")
			.setDesc(
				"Use the header as filename if the file starts with a header",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useHeader)
					.onChange(async (value) => {
						this.plugin.settings.useHeader = value;
						await this.plugin.saveSettings();
					});
			});

		// Setting 3
		new Setting(this.containerEl)
			.setName("Only use the first line")
			.setDesc(
				"Ignore succeeding lines of text when determining filename.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useFirstLine)
					.onChange(async (value) => {
						this.plugin.settings.useFirstLine = value;
						await this.plugin.saveSettings();
					});
			});

		// Setting 4
		const shouldDisable =
			!document.body.classList.contains("show-inline-title");
		const description: string = shouldDisable
			? 'Enable "Appearance > Interface > Show inline title" in options to use this setting.'
			: 'Override "Appearance > Interface > Show inline title" for files on the target folder.';
		new Setting(this.containerEl)
			.setName("Hide inline title for target folder")
			.setDesc(description)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.isTitleHidden)
					.onChange(async (value) => {
						this.plugin.settings.isTitleHidden = value;
						await this.plugin.saveSettings();
					});
			})
			//  Disable this setting if the obsidian setting "Show inline title" is disabled
			.setDisabled(shouldDisable)
			.then(async (setting) => {
				if (shouldDisable) {
					setting.settingEl.style.opacity = "0.5";
					setting.controlEl.getElementsByTagName(
						"input",
					)[0].disabled = true;
					setting.controlEl.getElementsByTagName(
						"input",
					)[0].style.cursor = "not-allowed";
				} else {
					setting.settingEl.style.opacity = "1";
					setting.controlEl.getElementsByTagName(
						"input",
					)[0].disabled = false;
					setting.controlEl.getElementsByTagName(
						"input",
					)[0].style.cursor = "pointer";
				}
			});

		// Setting 5
		new Setting(this.containerEl)
			.setName("YAML support")
			.setDesc("Enables YAML support.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.supportYAML)
					.onChange(async (value) => {
						this.plugin.settings.supportYAML = value;
						await this.plugin.saveSettings();
					});
			});

		// Setting 6
		new Setting(this.containerEl)
			.setName("Include Emojis")
			.setDesc("Include Emojis in the filename.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.includeEmojis)
					.onChange(async (value) => {
						this.plugin.settings.includeEmojis = value;
						await this.plugin.saveSettings();
					});
			});

		// Setting 7
		new Setting(this.containerEl)
			.setName("Character count")
			.setDesc(
				"Auto Filename will use the first x number of characters in file as filename.",
			)
			.addText((text) =>
				text
					.setPlaceholder(
						`10-100 (Default: ${DEFAULT_SETTINGS.charCount})`,
					)
					.setValue(String(this.plugin.settings.charCount))
					.onChange(async (value) => {
						const numVal = Number(value);
						if (numVal >= 10 && numVal <= 100) {
							this.plugin.settings.charCount = numVal;
							await this.plugin.saveSettings();
						}
					}),
			);

		// Setting 8
		new Setting(this.containerEl)
			.setName("Check interval")
			.setDesc(
				"Interval in milliseconds of how often to rename files while editing. Increase if there's performance issues.",
			)
			.addText((text) =>
				text
					.setPlaceholder(
						`Default: ${DEFAULT_SETTINGS.checkInterval}`,
					)
					.setValue(String(this.plugin.settings.checkInterval))
					.onChange(async (value) => {
						if (!isNaN(Number(value))) {
							this.plugin.settings.checkInterval = Number(value);
							await this.plugin.saveSettings();
						}
					}),
			);
		
		// Setting 9
		new Setting(this.containerEl)
			.setName("Skip named files")
			.setDesc(
				"If enabled, the plugin will only rename files that are untitled (starting with 'Untitled' or have no filename)."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.skipNamedFiles)
					.onChange(async (value) => {
						this.plugin.settings.skipNamedFiles = value;
						await this.plugin.saveSettings();
					});
			});

		// Setting 10
		new Setting(this.containerEl)
			.setName("Rename all files")
			.setDesc(
				"Force rename all files on the target folder. Warning: To be safe, make sure you backup before proceeding.",
			)
			.addButton((button) =>
				button.setButtonText("Rename").onClick(async () => {
					const filesToRename: TFile[] = [];
					this.app.vault.getMarkdownFiles().forEach((file) => {
						if (inTargetFolder(file, this.plugin.settings)) {
							filesToRename.push(file);
						}
					});

					new Notice(`Renaming files, please wait...`);

					renamedFileCount = 0;
					tempNewPaths = [];
					await Promise.all(
						filesToRename.map((file: TFile) =>
							this.plugin.renameFile(file, true),
						),
					);
					new Notice(
						`Renamed ${renamedFileCount}/${filesToRename.length} files.`,
					);
				}),
			);
	}
}
