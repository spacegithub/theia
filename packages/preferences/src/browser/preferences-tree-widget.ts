/********************************************************************************
 * Copyright (C) 2018 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { inject, postConstruct, named, injectable } from 'inversify';
import { Message } from '@phosphor/messaging';
import { PreferencesMenuFactory } from './preferences-menu-factory';
import { PreferencesDecorator } from './preferences-decorator';
import { toArray } from '@phosphor/algorithm';
import { BoxPanel, DockPanel, SplitPanel, Widget } from '@phosphor/widgets';
import {
    ApplicationShell,
    ContextMenuRenderer,
    ExpandableTreeNode,
    PreferenceDataProperty,
    PreferenceSchemaProvider,
    PreferenceScope,
    PreferenceService,
    Saveable,
    SelectableTreeNode,
    TreeModel,
    TreeNode,
    TreeProps,
    TreeWidget,
    WidgetManager,
    PreferenceProvider,
    LabelProvider
} from '@theia/core/lib/browser';
import { UserPreferenceProvider } from './user-preference-provider';
import { WorkspacePreferenceProvider } from './workspace-preference-provider';
import { PreferencesEditorWidget, PreferenceEditorContainerTabBarRenderer } from './preference-editor-widget';
import { EditorWidget, EditorManager } from '@theia/editor/lib/browser';
import { DisposableCollection, Emitter, Event, MessageService } from '@theia/core';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { FileSystem, FileSystemUtils } from '@theia/filesystem/lib/common';
import { UserStorageUri } from '@theia/userstorage/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import URI from '@theia/core/lib/common/uri';
import { FoldersPreferencesProvider } from './folders-preferences-provider';
import { PreferenceConfigurations } from '@theia/core/lib/browser/preferences/preference-configurations';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';

@injectable()
export class PreferencesContainer extends SplitPanel implements ApplicationShell.TrackableWidgetProvider, Saveable {

    static ID = 'preferences_container_widget';

    protected treeWidget: PreferencesTreeWidget | undefined;
    protected editorsContainer: PreferencesEditorsContainer;
    private currentEditor: PreferencesEditorWidget | undefined;
    private readonly editors: PreferencesEditorWidget[] = [];
    private deferredEditors = new Deferred<PreferencesEditorWidget[]>();

    protected readonly onDirtyChangedEmitter = new Emitter<void>();
    readonly onDirtyChanged: Event<void> = this.onDirtyChangedEmitter.event;

    protected readonly onDidChangeTrackableWidgetsEmitter = new Emitter<Widget[]>();
    readonly onDidChangeTrackableWidgets = this.onDidChangeTrackableWidgetsEmitter.event;

    protected readonly toDispose = new DisposableCollection();

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(PreferenceService)
    protected readonly preferenceService: PreferenceService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    protected _preferenceScope: PreferenceScope = PreferenceScope.User;

    @postConstruct()
    protected init(): void {
        this.id = PreferencesContainer.ID;
        this.title.label = 'Preferences';
        this.title.caption = this.title.label;
        this.title.closable = true;
        this.title.iconClass = 'fa fa-sliders';

        this.toDispose.pushAll([this.onDirtyChangedEmitter, this.onDidChangeTrackableWidgetsEmitter]);
    }

    dispose(): void {
        if (this.isDisposed) {
            return;
        }
        super.dispose();
        this.toDispose.dispose();
    }

    get autoSave(): 'on' | 'off' {
        return this.editors.some(editor => editor.saveable.autoSave === 'on') ? 'on' : 'off';
    }

    get dirty(): boolean {
        return this.editors.some(editor => editor.saveable.dirty);
    }

    save(): void {
        this.editors.forEach(editor => editor.saveable.save());
    }

    getTrackableWidgets(): Promise<Widget[]> {
        return this.deferredEditors.promise;
    }

    get preferenceScope(): PreferenceScope {
        return this._preferenceScope;
    }

    set preferenceScope(preferenceScope: PreferenceScope) {
        this._preferenceScope = preferenceScope;
    }

    protected async onAfterAttach(msg: Message): Promise<void> {
        if (this.widgets.length > 0) {
            return;
        }

        this.treeWidget = await this.widgetManager.getOrCreateWidget<PreferencesTreeWidget>(PreferencesTreeWidget.ID);
        this.treeWidget.onPreferenceSelected(value => {
            const preferenceName = Object.keys(value)[0];
            const preferenceValue = value[preferenceName];
            if (this.dirty) {
                this.messageService.warn('Preferences editor(s) has/have unsaved changes');
            } else if (this.currentEditor) {
                this.preferenceService.set(preferenceName, preferenceValue, this.currentEditor.scope, this.currentEditor.editor.uri.toString());
            }
        });

        this.editorsContainer = await this.widgetManager.getOrCreateWidget<PreferencesEditorsContainer>(PreferencesEditorsContainer.ID);
        this.toDispose.push(this.editorsContainer);
        this.editorsContainer.activatePreferenceEditor(this.preferenceScope);
        this.toDispose.push(this.editorsContainer.onInit(() => {
            this.handleEditorsChanged();
            this.deferredEditors.resolve(this.editors);
        }));
        this.toDispose.push(this.editorsContainer.onEditorChanged(editor => {
            if (this.currentEditor && this.currentEditor.editor.uri.toString() !== editor.editor.uri.toString()) {
                this.currentEditor.saveable.save();
            }
            if (editor) {
                this.preferenceScope = editor.scope || PreferenceScope.User;
            } else {
                this.preferenceScope = PreferenceScope.User;
            }
            this.currentEditor = editor;
        }));
        this.toDispose.push(this.editorsContainer.onFolderPreferenceEditorUriChanged(uriStr => {
            if (this.treeWidget) {
                this.treeWidget.setActiveFolder(uriStr);
            }
            this.handleEditorsChanged();
        }));
        this.toDispose.push(this.workspaceService.onWorkspaceLocationChanged(async workspaceFile => {
            await this.editorsContainer.refreshWorkspacePreferenceEditor();
            await this.refreshFoldersPreferencesEditor();
            this.handleEditorsChanged();
        }));
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(async roots => {
            await this.refreshFoldersPreferencesEditor();
        }));

        const treePanel = new BoxPanel();
        treePanel.addWidget(this.treeWidget);
        this.addWidget(treePanel);
        this.addWidget(this.editorsContainer);
        this.treeWidget.activate();
        super.onAfterAttach(msg);
    }

    protected onActivateRequest(msg: Message): void {
        if (this.currentEditor) {
            this.currentEditor.activate();
        }
        super.onActivateRequest(msg);
    }

    protected onCloseRequest(msg: Message): void {
        if (this.treeWidget) {
            this.treeWidget.close();
        }
        this.editorsContainer.close();
        super.onCloseRequest(msg);
        this.dispose();
    }

    public async activatePreferenceEditor(preferenceScope: PreferenceScope): Promise<void> {
        await this.deferredEditors.promise;
        this.doActivatePreferenceEditor(preferenceScope);
    }

    private doActivatePreferenceEditor(preferenceScope: PreferenceScope): void {
        this.preferenceScope = preferenceScope;
        if (this.editorsContainer) {
            this.editorsContainer.activatePreferenceEditor(preferenceScope);
        }
    }

    protected handleEditorsChanged(): void {
        const currentEditors = toArray(this.editorsContainer.widgets());
        currentEditors.forEach(editor => {
            if (editor instanceof EditorWidget && this.editors.findIndex(e => e === editor) < 0) {
                const editorWidget = editor as PreferencesEditorWidget;
                this.editors.push(editorWidget);
                const savable = editorWidget.saveable;
                savable.onDirtyChanged(() => {
                    this.onDirtyChangedEmitter.fire(undefined);
                });
            }
        });
        for (let i = this.editors.length - 1; i >= 0; i--) {
            if (currentEditors.findIndex(e => e === this.editors[i]) < 0) {
                this.editors.splice(i, 1);
            }
        }
        this.onDidChangeTrackableWidgetsEmitter.fire(this.editors);
        this.doActivatePreferenceEditor(this.preferenceScope);
    }

    private async refreshFoldersPreferencesEditor(): Promise<void> {
        const roots = this.workspaceService.tryGetRoots();
        if (roots.length === 0) {
            this.editorsContainer.closeFoldersPreferenceEditorWidget();
        } else if (!roots.some(r => r.uri === this.editorsContainer.activeFolder)) {
            const firstRoot = roots[0];
            await this.editorsContainer.refreshFoldersPreferencesEditorWidget(firstRoot ? firstRoot.uri : undefined);
        }
    }
}

@injectable()
export class PreferencesEditorsContainer extends DockPanel {

    static ID = 'preferences_editors_container';

    @inject(EditorManager)
    protected readonly editorManager: EditorManager;

    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;

    @inject(PreferenceProvider) @named(PreferenceScope.User)
    protected readonly userPreferenceProvider: UserPreferenceProvider;

    @inject(PreferenceProvider) @named(PreferenceScope.Workspace)
    protected readonly workspacePreferenceProvider: WorkspacePreferenceProvider;

    @inject(EnvVariablesServer)
    protected readonly envServer: EnvVariablesServer;

    private userPreferenceEditorWidget: PreferencesEditorWidget;
    private workspacePreferenceEditorWidget: PreferencesEditorWidget | undefined;
    private foldersPreferenceEditorWidget: PreferencesEditorWidget | undefined;

    private readonly onInitEmitter = new Emitter<void>();
    readonly onInit: Event<void> = this.onInitEmitter.event;

    private readonly onEditorChangedEmitter = new Emitter<PreferencesEditorWidget>();
    readonly onEditorChanged: Event<PreferencesEditorWidget> = this.onEditorChangedEmitter.event;

    private readonly onFolderPreferenceEditorUriChangedEmitter = new Emitter<string>();
    readonly onFolderPreferenceEditorUriChanged: Event<string> = this.onFolderPreferenceEditorUriChangedEmitter.event;

    protected readonly toDispose = new DisposableCollection(
        this.onEditorChangedEmitter,
        this.onInitEmitter
    );

    protected readonly toDisposeOnDetach = new DisposableCollection();

    constructor(
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService,
        @inject(FileSystem) protected readonly fileSystem: FileSystem,
        @inject(PreferenceProvider) @named(PreferenceScope.Folder)
        protected readonly foldersPreferenceProvider: FoldersPreferencesProvider
    ) {
        super({ renderer: new PreferenceEditorContainerTabBarRenderer(workspaceService, fileSystem, foldersPreferenceProvider) });
    }

    dispose(): void {
        this.toDispose.dispose();
        super.dispose();
    }

    onCloseRequest(msg: Message): void {
        toArray(this.widgets()).forEach(widget => widget.close());
        super.onCloseRequest(msg);
    }

    onUpdateRequest(msg: Message): void {
        const editor = this.selectedWidgets().next();
        if (editor) {
            this.onEditorChangedEmitter.fire(<PreferencesEditorWidget>editor);
        }
        super.onUpdateRequest(msg);
    }

    onBeforeDetach(): void {
        this.toDisposeOnDetach.dispose();
    }

    protected async onAfterAttach(msg: Message): Promise<void> {
        this.userPreferenceEditorWidget = await this.getUserPreferenceEditorWidget();
        this.addWidget(this.userPreferenceEditorWidget);
        await this.refreshWorkspacePreferenceEditor();
        await this.refreshFoldersPreferencesEditorWidget(undefined);

        super.onAfterAttach(msg);
        this.onInitEmitter.fire(undefined);
        this.toDisposeOnDetach.push(
            this.labelProvider.onDidChange(() => {
                // Listen to changes made by the label provider and apply updates to the preference editors.
                const icon = this.labelProvider.getIcon(new URI('settings.json'));
                this.userPreferenceEditorWidget.title.iconClass = icon;
                if (this.workspacePreferenceEditorWidget) {
                    // Explicitly update the workspace preference title to `Workspace` for single and multi-root workspaces.
                    this.workspacePreferenceEditorWidget.title.label = 'Workspace';
                    this.workspacePreferenceEditorWidget.title.iconClass = icon;
                }
            })
        );
    }

    protected async getUserPreferenceEditorWidget(): Promise<PreferencesEditorWidget> {
        const userPreferenceUri = this.userPreferenceProvider.getConfigUri();
        const userPreferences = await this.editorManager.getOrCreateByUri(userPreferenceUri) as PreferencesEditorWidget;
        userPreferences.title.label = 'User';
        userPreferences.title.iconClass = this.labelProvider.getIcon(new URI('settings.json'));
        userPreferences.title.caption = `User Preferences: ${await this.getPreferenceEditorCaption(userPreferenceUri)}`;
        userPreferences.scope = PreferenceScope.User;
        return userPreferences;
    }

    async refreshWorkspacePreferenceEditor(): Promise<void> {
        const newWorkspacePreferenceEditorWidget = await this.getWorkspacePreferenceEditorWidget();
        if (newWorkspacePreferenceEditorWidget) {
            this.addWidget(newWorkspacePreferenceEditorWidget,
                { ref: this.workspacePreferenceEditorWidget || this.userPreferenceEditorWidget });
            if (this.workspacePreferenceEditorWidget) {
                this.workspacePreferenceEditorWidget.close();
                this.workspacePreferenceEditorWidget.dispose();
            }
            this.workspacePreferenceEditorWidget = newWorkspacePreferenceEditorWidget;
        }
    }

    protected async getWorkspacePreferenceEditorWidget(): Promise<PreferencesEditorWidget | undefined> {
        const workspacePreferenceUri = this.workspacePreferenceProvider.getConfigUri();
        const workspacePreferences = workspacePreferenceUri && await this.editorManager.getOrCreateByUri(workspacePreferenceUri) as PreferencesEditorWidget;

        if (workspacePreferences) {
            workspacePreferences.title.label = 'Workspace';
            workspacePreferences.title.caption = `Workspace Preferences: ${await this.getPreferenceEditorCaption(workspacePreferenceUri!)}`;
            workspacePreferences.title.iconClass = this.labelProvider.getIcon(new URI('settings.json'));
            workspacePreferences.editor.setLanguage('jsonc');
            workspacePreferences.scope = PreferenceScope.Workspace;
        }
        return workspacePreferences;
    }

    get activeFolder(): string | undefined {
        if (this.foldersPreferenceEditorWidget) {
            return this.foldersPreferenceEditorWidget.editor.uri.parent.parent.toString();
        }
    }

    async refreshFoldersPreferencesEditorWidget(currentFolderUri: string | undefined): Promise<void> {
        const folders = this.workspaceService.tryGetRoots().map(r => r.uri);
        const newFolderUri = currentFolderUri || folders[0];
        const newFoldersPreferenceEditorWidget = await this.getFoldersPreferencesEditor(newFolderUri);
        if (newFoldersPreferenceEditorWidget && // new widget is created
            // the FolderPreferencesEditor is not available, OR the existing FolderPreferencesEditor is displaying the content of a different file
            (!this.foldersPreferenceEditorWidget || this.foldersPreferenceEditorWidget.editor.uri.parent.parent.toString() !== newFolderUri)) {
            this.addWidget(newFoldersPreferenceEditorWidget,
                { ref: this.foldersPreferenceEditorWidget || this.workspacePreferenceEditorWidget || this.userPreferenceEditorWidget });
            this.closeFoldersPreferenceEditorWidget();
            this.foldersPreferenceEditorWidget = newFoldersPreferenceEditorWidget;
            this.onFolderPreferenceEditorUriChangedEmitter.fire(newFoldersPreferenceEditorWidget.editor.uri.toString());
        }
    }

    closeFoldersPreferenceEditorWidget(): void {
        if (this.foldersPreferenceEditorWidget) {
            this.foldersPreferenceEditorWidget.close();
            this.foldersPreferenceEditorWidget.dispose();
            this.foldersPreferenceEditorWidget = undefined;
        }
    }

    protected async getFoldersPreferencesEditor(folderUri: string | undefined): Promise<PreferencesEditorWidget | undefined> {
        if (this.workspaceService.saved) {
            const settingsUri = await this.getFolderSettingsUri(folderUri);
            const foldersPreferences = settingsUri && await this.editorManager.getOrCreateByUri(settingsUri) as PreferencesEditorWidget;
            if (foldersPreferences) {
                foldersPreferences.title.label = 'Folder';
                foldersPreferences.title.caption = `Folder Preferences: ${await this.getPreferenceEditorCaption(settingsUri!)}`;
                foldersPreferences.title.clickableText = new URI(folderUri).displayName;
                foldersPreferences.title.clickableTextTooltip = 'Click to manage preferences in another folder';
                foldersPreferences.title.clickableTextCallback = async (folderUriStr: string) => {
                    await foldersPreferences.saveable.save();
                    await this.refreshFoldersPreferencesEditorWidget(folderUriStr);
                    this.activatePreferenceEditor(PreferenceScope.Folder);
                };
                foldersPreferences.scope = PreferenceScope.Folder;
            }
            return foldersPreferences;
        }
    }

    private async getFolderSettingsUri(folderUri: string | undefined): Promise<URI | undefined> {
        let configUri = this.foldersPreferenceProvider.getConfigUri(folderUri);
        if (!configUri) {
            configUri = this.foldersPreferenceProvider.getContainingConfigUri(folderUri);
            if (configUri) {
                await this.fileSystem.createFile(configUri.toString());
            }
        }
        return configUri;
    }

    activatePreferenceEditor(preferenceScope: PreferenceScope): void {
        for (const widget of toArray(this.widgets())) {
            const preferenceEditor = widget as PreferencesEditorWidget;
            if (preferenceEditor.scope === preferenceScope) {
                this.activateWidget(widget);
                break;
            }
        }
    }

    private async getPreferenceEditorCaption(preferenceUri: URI): Promise<string> {
        const homeStat = await this.fileSystem.getCurrentUserHome();
        const homeUri = homeStat ? new URI(homeStat.uri) : undefined;

        let uri = preferenceUri;
        if (preferenceUri.scheme === UserStorageUri.SCHEME && homeUri) {
            const configDirUri = await this.envServer.getConfigDirUri();
            uri = new URI(configDirUri).resolve(preferenceUri.path);
        }
        return homeUri
            ? FileSystemUtils.tildifyPath(uri.path.toString(), homeUri.path.toString())
            : uri.path.toString();
    }
}

@injectable()
export class PreferencesTreeWidget extends TreeWidget {

    static ID = 'preferences_tree_widget';

    private activeFolderUri: string | undefined;
    private preferencesGroupNames = new Set<string>();
    private properties: { [name: string]: PreferenceDataProperty };
    private readonly onPreferenceSelectedEmitter: Emitter<{ [key: string]: string }>;
    readonly onPreferenceSelected: Event<{ [key: string]: string }>;

    @inject(PreferencesMenuFactory) protected readonly preferencesMenuFactory: PreferencesMenuFactory;
    @inject(PreferenceService) protected readonly preferenceService: PreferenceService;
    @inject(PreferencesDecorator) protected readonly decorator: PreferencesDecorator;
    @inject(PreferenceConfigurations) protected readonly preferenceConfigs: PreferenceConfigurations;

    protected constructor(
        @inject(TreeModel) readonly model: TreeModel,
        @inject(TreeProps) protected readonly treeProps: TreeProps,
        @inject(ContextMenuRenderer) protected readonly contextMenuRenderer: ContextMenuRenderer,
        @inject(PreferenceSchemaProvider) protected readonly preferenceSchemaProvider: PreferenceSchemaProvider
    ) {
        super(treeProps, model, contextMenuRenderer);

        this.onPreferenceSelectedEmitter = new Emitter<{ [key: string]: string }>();
        this.onPreferenceSelected = this.onPreferenceSelectedEmitter.event;
        this.toDispose.push(this.onPreferenceSelectedEmitter);

        this.id = PreferencesTreeWidget.ID;
    }

    dispose(): void {
        super.dispose();
    }

    protected onAfterAttach(msg: Message): void {
        this.initializeModel();
        this.toDisposeOnDetach.push(this.preferenceSchemaProvider.onDidPreferenceSchemaChanged(() => {
            this.initializeModel();
        }));
        super.onAfterAttach(msg);
    }

    protected handleContextMenuEvent(node: TreeNode | undefined, event: React.MouseEvent<HTMLElement>): void {
        super.handleContextMenuEvent(node, event);
        if ((<ExpandableTreeNode>node).expanded === undefined) {
            this.openContextMenu(node, event.nativeEvent.x, event.nativeEvent.y);
        }
    }

    protected handleClickEvent(node: TreeNode | undefined, event: React.MouseEvent<HTMLElement>): void {
        super.handleClickEvent(node, event);
        if ((<ExpandableTreeNode>node).expanded === undefined) {
            this.openContextMenu(node, event.nativeEvent.x, event.nativeEvent.y);
        }
    }

    protected handleEnter(event: KeyboardEvent): void {
        super.handleEnter(event);
        const node: TreeNode = this.model.selectedNodes[0];
        if ((<ExpandableTreeNode>node).expanded === undefined) {
            if (node) {
                const nodeElement = document.getElementById(node.id);
                if (nodeElement) {
                    const position = nodeElement.getBoundingClientRect();
                    this.openContextMenu(this.model.selectedNodes[0], position.left, position.bottom);
                }
            }
        }
    }

    private openContextMenu(node: TreeNode | undefined, positionX: number, positionY: number): void {
        if (node && SelectableTreeNode.is(node)) {
            const contextMenu = this.preferencesMenuFactory.createPreferenceContextMenu(
                node.id,
                this.preferenceService.get(node.id, undefined, this.activeFolderUri),
                this.properties[node.id],
                (property, value) => {
                    this.onPreferenceSelectedEmitter.fire({ [property]: value });
                }
            );
            contextMenu.aboutToClose.connect(() => {
                this.activate();
            });
            contextMenu.activeItem = contextMenu.items[0];
            contextMenu.open(positionX, positionY);
        }
    }

    protected initializeModel(): void {
        this.properties = this.preferenceSchemaProvider.getCombinedSchema().properties;
        for (const property in this.properties) {
            if (property) {
                // Compute preference group name and accept those which have the proper format.
                const group: string = property.substring(0, property.indexOf('.'));
                if (property.split('.').length > 1) {
                    this.preferencesGroupNames.add(group);
                }
            }
        }

        type GroupNode = SelectableTreeNode & ExpandableTreeNode;
        const preferencesGroups: GroupNode[] = [];
        const nodes: { [id: string]: PreferenceDataProperty }[] = [];
        const groupNames: string[] = Array.from(this.preferencesGroupNames).sort((a, b) => this.sort(a, b));

        const root: ExpandableTreeNode = {
            id: 'root-node-id',
            name: 'Apply the preference to selected preferences file',
            parent: undefined,
            visible: true,
            children: preferencesGroups,
            expanded: true,
        };

        for (const group of groupNames) {
            const propertyNodes: SelectableTreeNode[] = [];
            const properties: string[] = [];

            // Add a preference property if it is currently part of the group name.
            // Properties which satisfy the condition `isSectionName` should not be added.
            for (const property in this.properties) {
                if (property.split('.', 1)[0] === group &&
                    !this.preferenceConfigs.isSectionName(property)) {
                    properties.push(property);
                }
            }

            // Build the group name node (used to categorize common preferences together).
            const preferencesGroup: GroupNode = {
                id: group + '-id',
                name: group.toLocaleUpperCase().substring(0, 1) + group.substring(1) + ' (' + properties.length + ')',
                visible: true,
                parent: root,
                children: propertyNodes,
                expanded: false,
                selected: false
            };

            properties.sort((a, b) => this.sort(a, b)).forEach(property => {
                const node: SelectableTreeNode = {
                    id: property,
                    name: property.substring(property.indexOf('.') + 1),
                    parent: preferencesGroup,
                    visible: true,
                    selected: false
                };
                propertyNodes.push(node);
                nodes.push({ [property]: this.properties[property] });
            });
            preferencesGroups.push(preferencesGroup);
        }
        this.decorator.fireDidChangeDecorations(nodes);
        this.model.root = root;
    }

    setActiveFolder(folder: string): void {
        this.activeFolderUri = folder;
        this.decorator.setActiveFolder(folder);
    }

    /**
     * Sort two string.
     *
     * @param a the first string.
     * @param b the second string.
     */
    protected sort(a: string, b: string): number {
        return a.localeCompare(b, undefined, { ignorePunctuation: true });
    }
}
