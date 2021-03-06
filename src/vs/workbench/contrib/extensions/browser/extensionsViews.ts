/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { Disposable } from 'vs/base/common/lifecycle';
import { Event, Emitter } from 'vs/base/common/event';
import { isPromiseCanceledError, getErrorMessage } from 'vs/base/common/errors';
import { PagedModel, IPagedModel, IPager, DelayedPagedModel } from 'vs/base/common/paging';
import { SortBy, SortOrder, IQueryOptions, IExtensionManagementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { IExtensionManagementServer, IExtensionManagementServerService, EnablementState } from 'vs/workbench/services/extensionManagement/common/extensionManagement';
import { IExtensionRecommendationsService } from 'vs/workbench/services/extensionRecommendations/common/extensionRecommendations';
import { areSameExtensions } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { append, $ } from 'vs/base/browser/dom';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Delegate, Renderer, IExtensionsViewState } from 'vs/workbench/contrib/extensions/browser/extensionsList';
import { IExtension, IExtensionsWorkbenchService } from 'vs/workbench/contrib/extensions/common/extensions';
import { Query } from 'vs/workbench/contrib/extensions/common/extensionQuery';
import { IExtensionService, toExtension } from 'vs/workbench/services/extensions/common/extensions';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { attachBadgeStyler } from 'vs/platform/theme/common/styler';
import { IViewletViewOptions } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { CountBadge } from 'vs/base/browser/ui/countBadge/countBadge';
import { ConfigureWorkspaceFolderRecommendedExtensionsAction, ManageExtensionAction, InstallLocalExtensionsInRemoteAction, getContextMenuActions, ExtensionAction } from 'vs/workbench/contrib/extensions/browser/extensionsActions';
import { WorkbenchPagedList, ListResourceNavigator } from 'vs/platform/list/browser/listService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { ViewPane, IViewPaneOptions } from 'vs/workbench/browser/parts/views/viewPaneContainer';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { coalesce, distinct, flatten } from 'vs/base/common/arrays';
import { IExperimentService, IExperiment, ExperimentActionType } from 'vs/workbench/contrib/experiments/common/experimentService';
import { alert } from 'vs/base/browser/ui/aria/aria';
import { IListContextMenuEvent } from 'vs/base/browser/ui/list/list';
import { createErrorWithActions } from 'vs/base/common/errorsWithActions';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IAction, Action, Separator } from 'vs/base/common/actions';
import { ExtensionType, ExtensionIdentifier, IExtensionDescription, isLanguagePackExtension } from 'vs/platform/extensions/common/extensions';
import { CancelablePromise, createCancelablePromise } from 'vs/base/common/async';
import { IProductService } from 'vs/platform/product/common/productService';
import { SeverityIcon } from 'vs/platform/severityIcon/common/severityIcon';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { SIDE_BAR_BACKGROUND } from 'vs/workbench/common/theme';
import { IMenuService } from 'vs/platform/actions/common/actions';
import { IViewDescriptorService } from 'vs/workbench/common/views';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IPreferencesService } from 'vs/workbench/services/preferences/common/preferences';
import { IListAccessibilityProvider } from 'vs/base/browser/ui/list/listWidget';

// Extensions that are automatically classified as Programming Language extensions, but should be Feature extensions
const FORCE_FEATURE_EXTENSIONS = ['vscode.git', 'vscode.search-result'];

type WorkspaceRecommendationsClassification = {
	count: { classification: 'SystemMetaData', purpose: 'FeatureInsight', 'isMeasurement': true };
};

class ExtensionsViewState extends Disposable implements IExtensionsViewState {

	private readonly _onFocus: Emitter<IExtension> = this._register(new Emitter<IExtension>());
	readonly onFocus: Event<IExtension> = this._onFocus.event;

	private readonly _onBlur: Emitter<IExtension> = this._register(new Emitter<IExtension>());
	readonly onBlur: Event<IExtension> = this._onBlur.event;

	private currentlyFocusedItems: IExtension[] = [];

	onFocusChange(extensions: IExtension[]): void {
		this.currentlyFocusedItems.forEach(extension => this._onBlur.fire(extension));
		this.currentlyFocusedItems = extensions;
		this.currentlyFocusedItems.forEach(extension => this._onFocus.fire(extension));
	}
}

export interface ExtensionsListViewOptions extends IViewletViewOptions {
	server?: IExtensionManagementServer;
}

class ExtensionListViewWarning extends Error { }

export class ExtensionsListView extends ViewPane {

	protected readonly server: IExtensionManagementServer | undefined;
	private bodyTemplate: {
		messageContainer: HTMLElement;
		messageSeverityIcon: HTMLElement;
		messageBox: HTMLElement;
		extensionsList: HTMLElement;
	} | undefined;
	private badge: CountBadge | undefined;
	private list: WorkbenchPagedList<IExtension> | null = null;
	private queryRequest: { query: string, request: CancelablePromise<IPagedModel<IExtension>> } | null = null;

	constructor(
		options: ExtensionsListViewOptions,
		@INotificationService protected notificationService: INotificationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService protected instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IExtensionsWorkbenchService protected extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IExtensionRecommendationsService protected extensionRecommendationsService: IExtensionRecommendationsService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkspaceContextService protected contextService: IWorkspaceContextService,
		@IExperimentService private readonly experimentService: IExperimentService,
		@IExtensionManagementServerService protected readonly extensionManagementServerService: IExtensionManagementServerService,
		@IExtensionManagementService protected readonly extensionManagementService: IExtensionManagementService,
		@IProductService protected readonly productService: IProductService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IMenuService private readonly menuService: IMenuService,
		@IOpenerService openerService: IOpenerService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
	) {
		super({ ...(options as IViewPaneOptions), showActionsAlways: true }, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService);
		this.server = options.server;
	}

	protected renderHeader(container: HTMLElement): void {
		container.classList.add('extension-view-header');
		super.renderHeader(container);

		this.badge = new CountBadge(append(container, $('.count-badge-wrapper')));
		this._register(attachBadgeStyler(this.badge, this.themeService));
	}

	renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const extensionsList = append(container, $('.extensions-list'));
		const messageContainer = append(container, $('.message-container'));
		const messageSeverityIcon = append(messageContainer, $(''));
		const messageBox = append(messageContainer, $('.message'));
		const delegate = new Delegate();
		const extensionsViewState = new ExtensionsViewState();
		const renderer = this.instantiationService.createInstance(Renderer, extensionsViewState);
		this.list = this.instantiationService.createInstance<typeof WorkbenchPagedList, WorkbenchPagedList<IExtension>>(WorkbenchPagedList, 'Extensions', extensionsList, delegate, [renderer], {
			multipleSelectionSupport: false,
			setRowLineHeight: false,
			horizontalScrolling: false,
			accessibilityProvider: <IListAccessibilityProvider<IExtension | null>>{
				getAriaLabel(extension: IExtension | null): string {
					return extension ? localize('extension-arialabel', "{0}, {1}, {2}, press enter for extension details.", extension.displayName, extension.version, extension.publisherDisplayName) : '';
				},
				getWidgetAriaLabel(): string {
					return localize('extensions', "Extensions");
				}
			},
			overrideStyles: {
				listBackground: SIDE_BAR_BACKGROUND
			}
		});
		this._register(this.list.onContextMenu(e => this.onContextMenu(e), this));
		this._register(this.list.onDidChangeFocus(e => extensionsViewState.onFocusChange(coalesce(e.elements)), this));
		this._register(this.list);
		this._register(extensionsViewState);

		const resourceNavigator = this._register(new ListResourceNavigator(this.list, { openOnSingleClick: true }));
		this._register(Event.debounce(Event.filter(resourceNavigator.onDidOpen, e => e.element !== null), (_, event) => event, 75, true)(options => {
			this.openExtension(this.list!.model.get(options.element!), { sideByside: options.sideBySide, ...options.editorOptions });
		}));

		this.bodyTemplate = {
			extensionsList,
			messageBox,
			messageContainer,
			messageSeverityIcon
		};
	}

	protected layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.bodyTemplate) {
			this.bodyTemplate.extensionsList.style.height = height + 'px';
		}
		if (this.list) {
			this.list.layout(height, width);
		}
	}

	async show(query: string): Promise<IPagedModel<IExtension>> {
		if (this.queryRequest) {
			if (this.queryRequest.query === query) {
				return this.queryRequest.request;
			}
			this.queryRequest.request.cancel();
			this.queryRequest = null;
		}

		const parsedQuery = Query.parse(query);

		let options: IQueryOptions = {
			sortOrder: SortOrder.Default
		};

		switch (parsedQuery.sortBy) {
			case 'installs': options.sortBy = SortBy.InstallCount; break;
			case 'rating': options.sortBy = SortBy.WeightedRating; break;
			case 'name': options.sortBy = SortBy.Title; break;
			case 'publishedDate': options.sortBy = SortBy.PublishedDate; break;
		}

		const successCallback = (model: IPagedModel<IExtension>) => {
			this.queryRequest = null;
			this.setModel(model);
			return model;
		};


		const errorCallback = (e: any) => {
			const model = new PagedModel([]);
			if (!isPromiseCanceledError(e)) {
				this.queryRequest = null;
				this.setModel(model, e);
			}
			return this.list ? this.list.model : model;
		};

		const request = createCancelablePromise(token => this.query(parsedQuery, options, token).then(successCallback).catch(errorCallback));
		this.queryRequest = { query, request };
		return request;
	}

	count(): number {
		return this.list ? this.list.length : 0;
	}

	protected showEmptyModel(): Promise<IPagedModel<IExtension>> {
		const emptyModel = new PagedModel([]);
		this.setModel(emptyModel);
		return Promise.resolve(emptyModel);
	}

	private async onContextMenu(e: IListContextMenuEvent<IExtension>): Promise<void> {
		if (e.element) {
			const runningExtensions = await this.extensionService.getExtensions();
			const manageExtensionAction = this.instantiationService.createInstance(ManageExtensionAction);
			manageExtensionAction.extension = e.element;
			if (manageExtensionAction.enabled) {
				const groups = await manageExtensionAction.getActionGroups(runningExtensions);
				let actions: IAction[] = [];
				for (const menuActions of groups) {
					actions = [...actions, ...menuActions, new Separator()];
				}
				this.contextMenuService.showContextMenu({
					getAnchor: () => e.anchor,
					getActions: () => actions.slice(0, actions.length - 1)
				});
			} else if (e.element) {
				const groups = getContextMenuActions(this.menuService, this.contextKeyService.createScoped(), this.instantiationService, e.element);
				groups.forEach(group => group.forEach(extensionAction => {
					if (extensionAction instanceof ExtensionAction) {
						extensionAction.extension = e.element!;
					}
				}));
				let actions: IAction[] = [];
				for (const menuActions of groups) {
					actions = [...actions, ...menuActions, new Separator()];
				}
				this.contextMenuService.showContextMenu({
					getAnchor: () => e.anchor,
					getActions: () => actions
				});
			}
		}
	}

	private async query(query: Query, options: IQueryOptions, token: CancellationToken): Promise<IPagedModel<IExtension>> {
		const idRegex = /@id:(([a-z0-9A-Z][a-z0-9\-A-Z]*)\.([a-z0-9A-Z][a-z0-9\-A-Z]*))/g;
		const ids: string[] = [];
		let idMatch;
		while ((idMatch = idRegex.exec(query.value)) !== null) {
			const name = idMatch[1];
			ids.push(name);
		}
		if (ids.length) {
			return this.queryByIds(ids, options, token);
		}
		if (ExtensionsListView.isLocalExtensionsQuery(query.value) || /@builtin/.test(query.value)) {
			return this.queryLocal(query, options);
		}
		return this.queryGallery(query, options, token)
			.then(null, e => {
				console.warn('Error querying extensions gallery', getErrorMessage(e));
				return Promise.reject(new ExtensionListViewWarning(localize('galleryError', "We cannot connect to the Extensions Marketplace at this time, please try again later.")));
			});
	}

	private async queryByIds(ids: string[], options: IQueryOptions, token: CancellationToken): Promise<IPagedModel<IExtension>> {
		const idsSet: Set<string> = ids.reduce((result, id) => { result.add(id.toLowerCase()); return result; }, new Set<string>());
		const result = (await this.extensionsWorkbenchService.queryLocal(this.server))
			.filter(e => idsSet.has(e.identifier.id.toLowerCase()));

		if (result.length) {
			return this.getPagedModel(this.sortExtensions(result, options));
		}

		return this.extensionsWorkbenchService.queryGallery({ names: ids, source: 'queryById' }, token)
			.then(pager => this.getPagedModel(pager));
	}

	private async queryLocal(query: Query, options: IQueryOptions): Promise<IPagedModel<IExtension>> {
		let value = query.value;
		if (/@builtin/i.test(value)) {
			const showThemesOnly = /@builtin:themes/i.test(value);
			if (showThemesOnly) {
				value = value.replace(/@builtin:themes/g, '');
			}
			const showBasicsOnly = /@builtin:basics/i.test(value);
			if (showBasicsOnly) {
				value = value.replace(/@builtin:basics/g, '');
			}
			const showFeaturesOnly = /@builtin:features/i.test(value);
			if (showFeaturesOnly) {
				value = value.replace(/@builtin:features/g, '');
			}

			value = value.replace(/@builtin/g, '').replace(/@sort:(\w+)(-\w*)?/g, '').trim().toLowerCase();
			let result = await this.extensionsWorkbenchService.queryLocal(this.server);

			result = result
				.filter(e => e.type === ExtensionType.System && (e.name.toLowerCase().indexOf(value) > -1 || e.displayName.toLowerCase().indexOf(value) > -1));

			const isThemeExtension = (e: IExtension): boolean => {
				return (Array.isArray(e.local?.manifest?.contributes?.themes) && e.local!.manifest!.contributes!.themes.length > 0)
					|| (Array.isArray(e.local?.manifest?.contributes?.iconThemes) && e.local!.manifest!.contributes!.iconThemes.length > 0);
			};
			if (showThemesOnly) {
				const themesExtensions = result.filter(isThemeExtension);
				return this.getPagedModel(this.sortExtensions(themesExtensions, options));
			}

			const isLangaugeBasicExtension = (e: IExtension): boolean => {
				return FORCE_FEATURE_EXTENSIONS.indexOf(e.identifier.id) === -1
					&& (Array.isArray(e.local?.manifest?.contributes?.grammars) && e.local!.manifest!.contributes!.grammars.length > 0);
			};
			if (showBasicsOnly) {
				const basics = result.filter(isLangaugeBasicExtension);
				return this.getPagedModel(this.sortExtensions(basics, options));
			}
			if (showFeaturesOnly) {
				const others = result.filter(e => {
					return e.local
						&& e.local.manifest
						&& !isThemeExtension(e)
						&& !isLangaugeBasicExtension(e);
				});
				return this.getPagedModel(this.sortExtensions(others, options));
			}

			return this.getPagedModel(this.sortExtensions(result, options));
		}

		const categories: string[] = [];
		value = value.replace(/\bcategory:("([^"]*)"|([^"]\S*))(\s+|\b|$)/g, (_, quotedCategory, category) => {
			const entry = (category || quotedCategory || '').toLowerCase();
			if (categories.indexOf(entry) === -1) {
				categories.push(entry);
			}
			return '';
		});

		if (/@installed/i.test(value)) {
			// Show installed extensions
			value = value.replace(/@installed/g, '').replace(/@sort:(\w+)(-\w*)?/g, '').trim().toLowerCase();

			let result = await this.extensionsWorkbenchService.queryLocal(this.server);

			result = result
				.filter(e => e.type === ExtensionType.User
					&& (e.name.toLowerCase().indexOf(value) > -1 || e.displayName.toLowerCase().indexOf(value) > -1)
					&& (!categories.length || categories.some(category => (e.local && e.local.manifest.categories || []).some(c => c.toLowerCase() === category))));

			if (options.sortBy !== undefined) {
				result = this.sortExtensions(result, options);
			} else {
				const runningExtensions = await this.extensionService.getExtensions();
				const runningExtensionsById = runningExtensions.reduce((result, e) => { result.set(ExtensionIdentifier.toKey(e.identifier.value), e); return result; }, new Map<string, IExtensionDescription>());
				result = result.sort((e1, e2) => {
					const running1 = runningExtensionsById.get(ExtensionIdentifier.toKey(e1.identifier.id));
					const isE1Running = running1 && this.extensionManagementServerService.getExtensionManagementServer(toExtension(running1)) === e1.server;
					const running2 = runningExtensionsById.get(ExtensionIdentifier.toKey(e2.identifier.id));
					const isE2Running = running2 && this.extensionManagementServerService.getExtensionManagementServer(toExtension(running2)) === e2.server;
					if ((isE1Running && isE2Running)) {
						return e1.displayName.localeCompare(e2.displayName);
					}
					const isE1LanguagePackExtension = e1.local && isLanguagePackExtension(e1.local.manifest);
					const isE2LanguagePackExtension = e2.local && isLanguagePackExtension(e2.local.manifest);
					if (!isE1Running && !isE2Running) {
						if (isE1LanguagePackExtension) {
							return -1;
						}
						if (isE2LanguagePackExtension) {
							return 1;
						}
						return e1.displayName.localeCompare(e2.displayName);
					}
					if ((isE1Running && isE2LanguagePackExtension) || (isE2Running && isE1LanguagePackExtension)) {
						return e1.displayName.localeCompare(e2.displayName);
					}
					return isE1Running ? -1 : 1;
				});
			}
			return this.getPagedModel(result);
		}


		if (/@outdated/i.test(value)) {
			value = value.replace(/@outdated/g, '').replace(/@sort:(\w+)(-\w*)?/g, '').trim().toLowerCase();

			const local = await this.extensionsWorkbenchService.queryLocal(this.server);
			const result = local
				.sort((e1, e2) => e1.displayName.localeCompare(e2.displayName))
				.filter(extension => extension.outdated
					&& (extension.name.toLowerCase().indexOf(value) > -1 || extension.displayName.toLowerCase().indexOf(value) > -1)
					&& (!categories.length || categories.some(category => !!extension.local && extension.local.manifest.categories!.some(c => c.toLowerCase() === category))));

			return this.getPagedModel(this.sortExtensions(result, options));
		}

		if (/@disabled/i.test(value)) {
			value = value.replace(/@disabled/g, '').replace(/@sort:(\w+)(-\w*)?/g, '').trim().toLowerCase();

			const local = await this.extensionsWorkbenchService.queryLocal(this.server);
			const runningExtensions = await this.extensionService.getExtensions();

			const result = local
				.sort((e1, e2) => e1.displayName.localeCompare(e2.displayName))
				.filter(e => runningExtensions.every(r => !areSameExtensions({ id: r.identifier.value, uuid: r.uuid }, e.identifier))
					&& (e.name.toLowerCase().indexOf(value) > -1 || e.displayName.toLowerCase().indexOf(value) > -1)
					&& (!categories.length || categories.some(category => (e.local && e.local.manifest.categories || []).some(c => c.toLowerCase() === category))));

			return this.getPagedModel(this.sortExtensions(result, options));
		}

		if (/@enabled/i.test(value)) {
			value = value ? value.replace(/@enabled/g, '').replace(/@sort:(\w+)(-\w*)?/g, '').trim().toLowerCase() : '';

			const local = (await this.extensionsWorkbenchService.queryLocal(this.server)).filter(e => e.type === ExtensionType.User);
			const runningExtensions = await this.extensionService.getExtensions();

			const result = local
				.sort((e1, e2) => e1.displayName.localeCompare(e2.displayName))
				.filter(e => runningExtensions.some(r => areSameExtensions({ id: r.identifier.value, uuid: r.uuid }, e.identifier))
					&& (e.name.toLowerCase().indexOf(value) > -1 || e.displayName.toLowerCase().indexOf(value) > -1)
					&& (!categories.length || categories.some(category => (e.local && e.local.manifest.categories || []).some(c => c.toLowerCase() === category))));

			return this.getPagedModel(this.sortExtensions(result, options));
		}

		return new PagedModel([]);
	}

	private async queryGallery(query: Query, options: IQueryOptions, token: CancellationToken): Promise<IPagedModel<IExtension>> {
		const hasUserDefinedSortOrder = options.sortBy !== undefined;
		if (!hasUserDefinedSortOrder && !query.value.trim()) {
			options.sortBy = SortBy.InstallCount;
		}

		if (this.isRecommendationsQuery(query)) {
			return this.queryRecommendations(query, options, token);
		}

		if (/\bcurated:([^\s]+)\b/.test(query.value)) {
			return this.getCuratedModel(query, options, token);
		}

		const text = query.value;

		if (/\bext:([^\s]+)\b/g.test(text)) {
			options.text = text;
			options.source = 'file-extension-tags';
			return this.extensionsWorkbenchService.queryGallery(options, token).then(pager => this.getPagedModel(pager));
		}

		let preferredResults: string[] = [];
		if (text) {
			options.text = text.substr(0, 350);
			options.source = 'searchText';
			if (!hasUserDefinedSortOrder) {
				const searchExperiments = await this.getSearchExperiments();
				for (const experiment of searchExperiments) {
					if (experiment.action && text.toLowerCase() === experiment.action.properties['searchText'] && Array.isArray(experiment.action.properties['preferredResults'])) {
						preferredResults = experiment.action.properties['preferredResults'];
						options.source += `-experiment-${experiment.id}`;
						break;
					}
				}
			}
		} else {
			options.source = 'viewlet';
		}

		const pager = await this.extensionsWorkbenchService.queryGallery(options, token);

		let positionToUpdate = 0;
		for (const preferredResult of preferredResults) {
			for (let j = positionToUpdate; j < pager.firstPage.length; j++) {
				if (areSameExtensions(pager.firstPage[j].identifier, { id: preferredResult })) {
					if (positionToUpdate !== j) {
						const preferredExtension = pager.firstPage.splice(j, 1)[0];
						pager.firstPage.splice(positionToUpdate, 0, preferredExtension);
						positionToUpdate++;
					}
					break;
				}
			}
		}
		return this.getPagedModel(pager);

	}

	private _searchExperiments: Promise<IExperiment[]> | undefined;
	private getSearchExperiments(): Promise<IExperiment[]> {
		if (!this._searchExperiments) {
			this._searchExperiments = this.experimentService.getExperimentsByType(ExperimentActionType.ExtensionSearchResults);
		}
		return this._searchExperiments;
	}

	private sortExtensions(extensions: IExtension[], options: IQueryOptions): IExtension[] {
		switch (options.sortBy) {
			case SortBy.InstallCount:
				extensions = extensions.sort((e1, e2) => typeof e2.installCount === 'number' && typeof e1.installCount === 'number' ? e2.installCount - e1.installCount : NaN);
				break;
			case SortBy.AverageRating:
			case SortBy.WeightedRating:
				extensions = extensions.sort((e1, e2) => typeof e2.rating === 'number' && typeof e1.rating === 'number' ? e2.rating - e1.rating : NaN);
				break;
			default:
				extensions = extensions.sort((e1, e2) => e1.displayName.localeCompare(e2.displayName));
				break;
		}
		if (options.sortOrder === SortOrder.Descending) {
			extensions = extensions.reverse();
		}
		return extensions;
	}

	private async getCuratedModel(query: Query, options: IQueryOptions, token: CancellationToken): Promise<IPagedModel<IExtension>> {
		const value = query.value.replace(/curated:/g, '').trim();
		const names = await this.experimentService.getCuratedExtensionsList(value);
		if (Array.isArray(names) && names.length) {
			options.source = `curated:${value}`;
			options.names = names;
			options.pageSize = names.length;
			const pager = await this.extensionsWorkbenchService.queryGallery(options, token);
			this.sortFirstPage(pager, names);
			return this.getPagedModel(pager || []);
		}
		return new PagedModel([]);
	}

	private isRecommendationsQuery(query: Query): boolean {
		return ExtensionsListView.isWorkspaceRecommendedExtensionsQuery(query.value)
			|| ExtensionsListView.isKeymapsRecommendedExtensionsQuery(query.value)
			|| ExtensionsListView.isExeRecommendedExtensionsQuery(query.value)
			|| /@recommended:all/i.test(query.value)
			|| ExtensionsListView.isSearchRecommendedExtensionsQuery(query.value)
			|| ExtensionsListView.isRecommendedExtensionsQuery(query.value);
	}

	private async queryRecommendations(query: Query, options: IQueryOptions, token: CancellationToken): Promise<IPagedModel<IExtension>> {
		// Workspace recommendations
		if (ExtensionsListView.isWorkspaceRecommendedExtensionsQuery(query.value)) {
			return this.getWorkspaceRecommendationsModel(query, options, token);
		}

		// Keymap recommendations
		if (ExtensionsListView.isKeymapsRecommendedExtensionsQuery(query.value)) {
			return this.getKeymapRecommendationsModel(query, options, token);
		}

		// Exe recommendations
		if (ExtensionsListView.isExeRecommendedExtensionsQuery(query.value)) {
			return this.getExeRecommendationsModel(query, options, token);
		}

		// All recommendations
		if (/@recommended:all/i.test(query.value) || ExtensionsListView.isSearchRecommendedExtensionsQuery(query.value)) {
			return this.getAllRecommendationsModel(query, options, token);
		}

		// Other recommendations
		if (ExtensionsListView.isRecommendedExtensionsQuery(query.value)) {
			return this.getOtherRecommendationsModel(query, options, token);
		}

		return new PagedModel([]);
	}

	protected async getInstallableRecommendations(recommendations: string[], options: IQueryOptions, token: CancellationToken): Promise<IExtension[]> {
		const extensions: IExtension[] = [];
		if (recommendations.length) {
			const pager = await this.extensionsWorkbenchService.queryGallery({ ...options, names: recommendations, pageSize: recommendations.length }, token);
			for (const extension of pager.firstPage) {
				if (extension.gallery && (await this.extensionManagementService.canInstall(extension.gallery))) {
					extensions.push(extension);
				}
			}
		}
		return extensions;
	}

	protected async getWorkspaceRecommendations(): Promise<string[]> {
		const recommendations = await this.extensionRecommendationsService.getWorkspaceRecommendations();
		const { important } = await this.extensionRecommendationsService.getConfigBasedRecommendations();
		for (const configBasedRecommendation of important) {
			if (!recommendations.find(extensionId => extensionId === configBasedRecommendation)) {
				recommendations.push(configBasedRecommendation);
			}
		}
		return recommendations;
	}

	private async getWorkspaceRecommendationsModel(query: Query, options: IQueryOptions, token: CancellationToken): Promise<IPagedModel<IExtension>> {
		const value = query.value.replace(/@recommended:workspace/g, '').trim().toLowerCase();
		const recommendations = await this.getWorkspaceRecommendations();
		const installableRecommendations = (await this.getInstallableRecommendations(recommendations, { ...options, source: 'recommendations-workspace' }, token))
			.filter(extension => extension.identifier.id.toLowerCase().indexOf(value) > -1);
		this.telemetryService.publicLog2<{ count: number }, WorkspaceRecommendationsClassification>('extensionWorkspaceRecommendations:open', { count: installableRecommendations.length });
		const result: IExtension[] = coalesce(recommendations.map(id => installableRecommendations.find(i => areSameExtensions(i.identifier, { id }))));
		return new PagedModel(result);
	}

	private async getKeymapRecommendationsModel(query: Query, options: IQueryOptions, token: CancellationToken): Promise<IPagedModel<IExtension>> {
		const value = query.value.replace(/@recommended:keymaps/g, '').trim().toLowerCase();
		const recommendations = this.extensionRecommendationsService.getKeymapRecommendations();
		const installableRecommendations = (await this.getInstallableRecommendations(recommendations, { ...options, source: 'recommendations-keymaps' }, token))
			.filter(extension => extension.identifier.id.toLowerCase().indexOf(value) > -1);
		return new PagedModel(installableRecommendations);
	}

	private async getExeRecommendationsModel(query: Query, options: IQueryOptions, token: CancellationToken): Promise<IPagedModel<IExtension>> {
		const exe = query.value.replace(/@exe:/g, '').trim().toLowerCase();
		const { important, others } = await this.extensionRecommendationsService.getExeBasedRecommendations(exe.startsWith('"') ? exe.substring(1, exe.length - 1) : exe);
		const installableRecommendations = await this.getInstallableRecommendations([...important, ...others], { ...options, source: 'recommendations-exe' }, token);
		return new PagedModel(installableRecommendations);
	}

	private async getOtherRecommendationsModel(query: Query, options: IQueryOptions, token: CancellationToken): Promise<IPagedModel<IExtension>> {
		const value = query.value.replace(/@recommended/g, '').trim().toLowerCase();

		const local = (await this.extensionsWorkbenchService.queryLocal(this.server))
			.filter(e => e.type === ExtensionType.User)
			.map(e => e.identifier.id.toLowerCase());
		const workspaceRecommendations = (await this.getWorkspaceRecommendations())
			.map(extensionId => extensionId.toLowerCase());

		const otherRecommendations = distinct(
			flatten(await Promise.all([
				// Order is important
				this.extensionRecommendationsService.getImportantRecommendations(),
				this.extensionRecommendationsService.getFileBasedRecommendations(),
				this.extensionRecommendationsService.getOtherRecommendations()
			])).filter(extensionId => !local.includes(extensionId.toLowerCase()) && !workspaceRecommendations.includes(extensionId.toLowerCase())
			), extensionId => extensionId.toLowerCase());

		const installableRecommendations = (await this.getInstallableRecommendations(otherRecommendations, { ...options, source: 'recommendations-other', sortBy: undefined }, token))
			.filter(extension => extension.identifier.id.toLowerCase().indexOf(value) > -1);

		const result: IExtension[] = coalesce(otherRecommendations.map(id => installableRecommendations.find(i => areSameExtensions(i.identifier, { id }))));
		return new PagedModel(result);
	}

	// Get All types of recommendations, trimmed to show a max of 8 at any given time
	private async getAllRecommendationsModel(query: Query, options: IQueryOptions, token: CancellationToken): Promise<IPagedModel<IExtension>> {
		const local = (await this.extensionsWorkbenchService.queryLocal(this.server))
			.filter(e => e.type === ExtensionType.User)
			.map(e => e.identifier.id.toLowerCase());

		const allRecommendations = distinct(
			flatten(await Promise.all([
				// Order is important
				this.getWorkspaceRecommendations(),
				this.extensionRecommendationsService.getImportantRecommendations(),
				this.extensionRecommendationsService.getFileBasedRecommendations(),
				this.extensionRecommendationsService.getOtherRecommendations()
			])).filter(extensionId => !local.includes(extensionId.toLowerCase())
			), extensionId => extensionId.toLowerCase());

		const installableRecommendations = await this.getInstallableRecommendations(allRecommendations, { ...options, source: 'recommendations-all', sortBy: undefined }, token);
		const result: IExtension[] = coalesce(allRecommendations.map(id => installableRecommendations.find(i => areSameExtensions(i.identifier, { id }))));
		return new PagedModel(result.slice(0, 8));
	}

	// Sorts the firstPage of the pager in the same order as given array of extension ids
	private sortFirstPage(pager: IPager<IExtension>, ids: string[]) {
		ids = ids.map(x => x.toLowerCase());
		pager.firstPage.sort((a, b) => {
			return ids.indexOf(a.identifier.id.toLowerCase()) < ids.indexOf(b.identifier.id.toLowerCase()) ? -1 : 1;
		});
	}

	private setModel(model: IPagedModel<IExtension>, error?: any) {
		if (this.list) {
			this.list.model = new DelayedPagedModel(model);
			this.list.scrollTop = 0;
			const count = this.count();

			if (this.bodyTemplate && this.badge) {

				this.bodyTemplate.extensionsList.classList.toggle('hidden', count === 0);
				this.bodyTemplate.messageContainer.classList.toggle('hidden', count > 0);
				this.badge.setCount(count);

				if (count === 0 && this.isBodyVisible()) {
					if (error) {
						if (error instanceof ExtensionListViewWarning) {
							this.bodyTemplate.messageSeverityIcon.className = `codicon ${SeverityIcon.className(Severity.Warning)}`;
							this.bodyTemplate.messageBox.textContent = getErrorMessage(error);
						} else {
							this.bodyTemplate.messageSeverityIcon.className = `codicon ${SeverityIcon.className(Severity.Error)}`;
							this.bodyTemplate.messageBox.textContent = localize('error', "Error while loading extensions. {0}", getErrorMessage(error));
						}
					} else {
						this.bodyTemplate.messageSeverityIcon.className = '';
						this.bodyTemplate.messageBox.textContent = localize('no extensions found', "No extensions found.");
					}
					alert(this.bodyTemplate.messageBox.textContent);
				}
			}
		}
	}

	private openExtension(extension: IExtension, options: { sideByside?: boolean, preserveFocus?: boolean, pinned?: boolean }): void {
		extension = this.extensionsWorkbenchService.local.filter(e => areSameExtensions(e.identifier, extension.identifier))[0] || extension;
		this.extensionsWorkbenchService.open(extension, options).then(undefined, err => this.onError(err));
	}

	private onError(err: any): void {
		if (isPromiseCanceledError(err)) {
			return;
		}

		const message = err && err.message || '';

		if (/ECONNREFUSED/.test(message)) {
			const error = createErrorWithActions(localize('suggestProxyError', "Marketplace returned 'ECONNREFUSED'. Please check the 'http.proxy' setting."), {
				actions: [
					new Action('open user settings', localize('open user settings', "Open User Settings"), undefined, true, () => this.preferencesService.openGlobalSettings())
				]
			});

			this.notificationService.error(error);
			return;
		}

		this.notificationService.error(err);
	}

	private getPagedModel(arg: IPager<IExtension> | IExtension[]): IPagedModel<IExtension> {
		if (Array.isArray(arg)) {
			return new PagedModel(arg);
		}
		const pager = {
			total: arg.total,
			pageSize: arg.pageSize,
			firstPage: arg.firstPage,
			getPage: (pageIndex: number, cancellationToken: CancellationToken) => arg.getPage(pageIndex, cancellationToken)
		};
		return new PagedModel(pager);
	}

	dispose(): void {
		super.dispose();
		if (this.queryRequest) {
			this.queryRequest.request.cancel();
			this.queryRequest = null;
		}
		this.list = null;
	}

	static isLocalExtensionsQuery(query: string): boolean {
		return this.isInstalledExtensionsQuery(query)
			|| this.isOutdatedExtensionsQuery(query)
			|| this.isEnabledExtensionsQuery(query)
			|| this.isDisabledExtensionsQuery(query)
			|| this.isBuiltInExtensionsQuery(query)
			|| this.isSearchBuiltInExtensionsQuery(query);
	}

	static isSearchBuiltInExtensionsQuery(query: string): boolean {
		return /@builtin\s.+/i.test(query);
	}

	static isBuiltInExtensionsQuery(query: string): boolean {
		return /@builtin$/i.test(query.trim());
	}

	static isInstalledExtensionsQuery(query: string): boolean {
		return /@installed/i.test(query);
	}

	static isOutdatedExtensionsQuery(query: string): boolean {
		return /@outdated/i.test(query);
	}

	static isEnabledExtensionsQuery(query: string): boolean {
		return /@enabled/i.test(query);
	}

	static isDisabledExtensionsQuery(query: string): boolean {
		return /@disabled/i.test(query);
	}

	static isRecommendedExtensionsQuery(query: string): boolean {
		return /^@recommended$/i.test(query.trim());
	}

	static isSearchRecommendedExtensionsQuery(query: string): boolean {
		return /@recommended/i.test(query) && !ExtensionsListView.isRecommendedExtensionsQuery(query);
	}

	static isWorkspaceRecommendedExtensionsQuery(query: string): boolean {
		return /@recommended:workspace/i.test(query);
	}

	static isExeRecommendedExtensionsQuery(query: string): boolean {
		return /@exe:.+/i.test(query);
	}

	static isKeymapsRecommendedExtensionsQuery(query: string): boolean {
		return /@recommended:keymaps/i.test(query);
	}

	focus(): void {
		super.focus();
		if (!this.list) {
			return;
		}

		if (!(this.list.getFocus().length || this.list.getSelection().length)) {
			this.list.focusNext();
		}
		this.list.domFocus();
	}
}

export class ServerExtensionsView extends ExtensionsListView {

	constructor(
		server: IExtensionManagementServer,
		onDidChangeTitle: Event<string>,
		options: ExtensionsListViewOptions,
		@INotificationService notificationService: INotificationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IExtensionService extensionService: IExtensionService,
		@IExtensionRecommendationsService tipsService: IExtensionRecommendationsService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IExperimentService experimentService: IExperimentService,
		@IExtensionsWorkbenchService extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IExtensionManagementServerService extensionManagementServerService: IExtensionManagementServerService,
		@IExtensionManagementService extensionManagementService: IExtensionManagementService,
		@IProductService productService: IProductService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IMenuService menuService: IMenuService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IPreferencesService preferencesService: IPreferencesService,
	) {
		options.server = server;
		super(options, notificationService, keybindingService, contextMenuService, instantiationService, themeService, extensionService, extensionsWorkbenchService, tipsService,
			telemetryService, configurationService, contextService, experimentService, extensionManagementServerService, extensionManagementService, productService,
			contextKeyService, viewDescriptorService, menuService, openerService, preferencesService);
		this._register(onDidChangeTitle(title => this.updateTitle(title)));
	}

	async show(query: string): Promise<IPagedModel<IExtension>> {
		query = query ? query : '@installed';
		if (!ExtensionsListView.isLocalExtensionsQuery(query)) {
			query = query += ' @installed';
		}
		return super.show(query.trim());
	}

	getActions(): IAction[] {
		if (this.extensionManagementServerService.remoteExtensionManagementServer && this.extensionManagementServerService.localExtensionManagementServer === this.server) {
			const installLocalExtensionsInRemoteAction = this._register(this.instantiationService.createInstance(InstallLocalExtensionsInRemoteAction));
			installLocalExtensionsInRemoteAction.class = 'codicon codicon-cloud-download';
			return [installLocalExtensionsInRemoteAction];
		}
		return [];
	}
}

export class EnabledExtensionsView extends ExtensionsListView {

	async show(query: string): Promise<IPagedModel<IExtension>> {
		query = query || '@enabled';
		return ExtensionsListView.isEnabledExtensionsQuery(query) ? super.show(query) : this.showEmptyModel();
	}
}

export class DisabledExtensionsView extends ExtensionsListView {

	async show(query: string): Promise<IPagedModel<IExtension>> {
		query = query || '@disabled';
		return ExtensionsListView.isDisabledExtensionsQuery(query) ? super.show(query) : this.showEmptyModel();
	}
}

export class OutdatedExtensionsView extends ExtensionsListView {

	async show(query: string): Promise<IPagedModel<IExtension>> {
		query = query || '@outdated';
		return ExtensionsListView.isOutdatedExtensionsQuery(query) ? super.show(query) : this.showEmptyModel();
	}
}

export class InstalledExtensionsView extends ExtensionsListView {

	async show(query: string): Promise<IPagedModel<IExtension>> {
		query = query || '@installed';
		return ExtensionsListView.isInstalledExtensionsQuery(query) ? super.show(query) : this.showEmptyModel();
	}
}

export class SearchBuiltInExtensionsView extends ExtensionsListView {
	async show(query: string): Promise<IPagedModel<IExtension>> {
		return ExtensionsListView.isSearchBuiltInExtensionsQuery(query) ? super.show(query) : this.showEmptyModel();
	}
}

export class BuiltInFeatureExtensionsView extends ExtensionsListView {
	async show(query: string): Promise<IPagedModel<IExtension>> {
		return (query && query.trim() !== '@builtin') ? this.showEmptyModel() : super.show('@builtin:features');
	}
}

export class BuiltInThemesExtensionsView extends ExtensionsListView {
	async show(query: string): Promise<IPagedModel<IExtension>> {
		return (query && query.trim() !== '@builtin') ? this.showEmptyModel() : super.show('@builtin:themes');
	}
}

export class BuiltInProgrammingLanguageExtensionsView extends ExtensionsListView {
	async show(query: string): Promise<IPagedModel<IExtension>> {
		return (query && query.trim() !== '@builtin') ? this.showEmptyModel() : super.show('@builtin:basics');
	}
}

export class DefaultRecommendedExtensionsView extends ExtensionsListView {
	private readonly recommendedExtensionsQuery = '@recommended:all';

	renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._register(this.extensionRecommendationsService.onRecommendationChange(() => {
			this.show('');
		}));
	}

	async show(query: string): Promise<IPagedModel<IExtension>> {
		if (query && query.trim() !== this.recommendedExtensionsQuery) {
			return this.showEmptyModel();
		}
		const model = await super.show(this.recommendedExtensionsQuery);
		if (!this.extensionsWorkbenchService.local.some(e => e.type === ExtensionType.User)) {
			// This is part of popular extensions view. Collapse if no installed extensions.
			this.setExpanded(model.length > 0);
		}
		return model;
	}

}

export class RecommendedExtensionsView extends ExtensionsListView {
	private readonly recommendedExtensionsQuery = '@recommended';

	renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._register(this.extensionRecommendationsService.onRecommendationChange(() => {
			this.show('');
		}));
	}

	async show(query: string): Promise<IPagedModel<IExtension>> {
		return (query && query.trim() !== this.recommendedExtensionsQuery) ? this.showEmptyModel() : super.show(this.recommendedExtensionsQuery);
	}
}

export class WorkspaceRecommendedExtensionsView extends ExtensionsListView {
	private readonly recommendedExtensionsQuery = '@recommended:workspace';
	private installAllAction: Action | undefined;

	renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._register(this.extensionRecommendationsService.onRecommendationChange(() => this.show(this.recommendedExtensionsQuery)));
		this._register(this.contextService.onDidChangeWorkbenchState(() => this.show(this.recommendedExtensionsQuery)));
	}

	getActions(): IAction[] {
		if (!this.installAllAction) {
			this.installAllAction = this._register(new Action('workbench.extensions.action.installWorkspaceRecommendedExtensions', localize('installWorkspaceRecommendedExtensions', "Install Workspace Recommended Extensions"), 'codicon codicon-cloud-download', false, () => this.installWorkspaceRecommendations()));
		}

		const configureWorkspaceFolderAction = this._register(this.instantiationService.createInstance(ConfigureWorkspaceFolderRecommendedExtensionsAction, ConfigureWorkspaceFolderRecommendedExtensionsAction.ID, ConfigureWorkspaceFolderRecommendedExtensionsAction.LABEL));
		configureWorkspaceFolderAction.class = 'codicon codicon-pencil';
		return [this.installAllAction, configureWorkspaceFolderAction];
	}

	async show(query: string): Promise<IPagedModel<IExtension>> {
		let shouldShowEmptyView = query && query.trim() !== '@recommended' && query.trim() !== '@recommended:workspace';
		let model = await (shouldShowEmptyView ? this.showEmptyModel() : super.show(this.recommendedExtensionsQuery));
		this.setExpanded(model.length > 0);
		await this.setRecommendationsToInstall();
		return model;
	}

	private async setRecommendationsToInstall(): Promise<void> {
		const installableRecommendations = await this.getInstallableWorkspaceRecommendations();
		if (this.installAllAction) {
			this.installAllAction.enabled = installableRecommendations.length > 0;
		}
	}

	private async getInstallableWorkspaceRecommendations() {
		const installed = (await this.extensionsWorkbenchService.queryLocal())
			.filter(l => l.enablementState !== EnablementState.DisabledByExtensionKind); // Filter extensions disabled by kind
		const recommendations = (await this.getWorkspaceRecommendations())
			.filter(extensionId => installed.every(local => !areSameExtensions({ id: extensionId }, local.identifier)));
		return this.getInstallableRecommendations(recommendations, { source: 'install-all-workspace-recommendations' }, CancellationToken.None);
	}

	private async installWorkspaceRecommendations(): Promise<void> {
		const installableRecommendations = await this.getInstallableWorkspaceRecommendations();
		await Promise.all(installableRecommendations.map(extension => this.extensionManagementService.installFromGallery(extension.gallery!)));
	}

}
