import { CorrectionApi } from '@apis/CorrectionApi';
import { ServiceApi } from '@apis/ServiceApi';
import { TmdbApi } from '@apis/TmdbApi';
import { TraktSync } from '@apis/TraktSync';
import { BrowserStorage } from '@common/BrowserStorage';
import {
	EventDispatcher,
	HistorySyncSuccessData,
	ItemCorrectedData,
	MissingWatchedDateAddedData,
	StorageOptionsChangeData,
} from '@common/Events';
import { HistoryListItem, HistoryListItemProps } from '@components/HistoryListItem';
import { useHistory } from '@contexts/HistoryContext';
import { useSync } from '@contexts/SyncContext';
import { Item } from '@models/Item';
import { Box } from '@mui/material';
import { SyncStore } from '@stores/SyncStore';
import { RefCallback, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AutoSizer from 'react-virtualized-auto-sizer';
import { VariableSizeList } from 'react-window';
import InfiniteLoader from 'react-window-infinite-loader';

export type LastSyncValues = Record<string, LastSyncValue>;

export interface LastSyncValue {
	lastSync: number;
	lastSyncId: string;
}

const ITEMS_PER_LOAD = 10;
const lastSyncValues = {} as LastSyncValues;

const calculateItemCount = (serviceId: string | null, store: SyncStore) => {
	return (
		store.data.items.length + (store.data.hasReachedEnd ? 1 : ITEMS_PER_LOAD) + (serviceId ? 0 : 1)
	);
};

const calculateTotalItems = (serviceId: string | null, store: SyncStore) => {
	return store.data.items.length + (store.data.hasReachedEnd ? 1 : 0) + (serviceId ? 0 : 1);
};

export const HistoryList = (): JSX.Element => {
	const history = useHistory();
	const { serviceId, service, api, store } = useSync();

	const [itemCount, setItemCount] = useState(calculateItemCount(serviceId, store));
	const [continueLoading, setContinueLoading] = useState(false);

	const listRef = useRef<VariableSizeList<HistoryListItemProps> | null>(null);
	if (service && !lastSyncValues[service.id]) {
		const serviceOptions = BrowserStorage.options.services[service.id];
		lastSyncValues[service.id] =
			service.hasAutoSync && serviceOptions?.autoSync && serviceOptions.autoSyncDays > 0
				? {
						lastSync: serviceOptions.lastSync,
						lastSyncId: serviceOptions.lastSyncId,
				  }
				: {
						lastSync: 0,
						lastSyncId: '',
				  };
	}
	const lastSyncValue = serviceId
		? lastSyncValues[serviceId]
		: {
				lastSync: 0,
				lastSyncId: '',
		  };

	const startLoading = async (items: Item[]) => {
		store.data.isLoading = true;
		await EventDispatcher.dispatch('SYNC_STORE_LOADING_START', null, {});
		const newItems = items.map((item) => {
			const newItem = item.clone();
			newItem.isLoading = true;
			return newItem;
		});
		await store.update(newItems, true);
		return newItems;
	};

	const stopLoading = async (items: Item[]) => {
		store.data.isLoading = false;
		await EventDispatcher.dispatch('SYNC_STORE_LOADING_STOP', null, {});
		const newItems = items.map((item) => {
			const newItem = item.clone();
			newItem.isLoading = false;
			return newItem;
		});
		await store.update(newItems, true);
		return newItems;
	};

	const checkEnd = async () => {
		if (store.data.hasReachedEnd) {
			await EventDispatcher.dispatch('ITEMS_LOAD', null, {
				items: {
					[store.data.items.length]: null,
				},
			});
		}
	};

	const loadMoreItems = async (startIndex: number, stopIndex: number) => {
		if (!serviceId || !service || !api) {
			return;
		}
		if (startIndex < store.data.items.length) {
			// Index already loaded
			return;
		}
		if (store.data.isLoading) {
			store.data.loadQueue.push(startIndex);
			return;
		}

		await startLoading([]);
		let items: Item[] = [];
		try {
			const { hasReachedLastSyncDate } = store.data;
			if (hasReachedLastSyncDate) {
				await store.setData({ hasReachedLastSyncDate: false });
			}
			items = await api.loadHistory(
				ITEMS_PER_LOAD,
				lastSyncValue.lastSync,
				lastSyncValue.lastSyncId
			);
			items = await checkHiddenSelected(items);
			items = await loadData(items);
		} catch (err) {
			// Do nothing
		}
		await stopLoading(items);
		await checkEnd();

		const nextStartIndex = store.data.loadQueue.pop();
		if (typeof nextStartIndex !== 'undefined') {
			void loadMoreItems(nextStartIndex, nextStartIndex + (ITEMS_PER_LOAD - 1));
		}
	};

	const loadData = async (items: Item[]) => {
		items = await ServiceApi.loadTraktHistory(items, processItem);
		items = await CorrectionApi.loadSuggestions(items);
		await store.update(items, true);
		items = await TmdbApi.loadImages(items);
		await store.update(items, true);
		return items;
	};

	const processItem = async (item: Item) => {
		const [newItem] = await checkHiddenSelected([item]);
		await store.update([newItem], true);
		return newItem;
	};

	const onContinueLoadingClick = async () => {
		if (!service) {
			return;
		}
		await store.setData({ hasReachedEnd: false });
		if (lastSyncValues[service.id]) {
			lastSyncValues[service.id] = {
				lastSync: 0,
				lastSyncId: '',
			};
		}
		setContinueLoading(true);
	};

	const addWithReleaseDate = async (items: Item[]): Promise<Item[]> => {
		let newItems = await startLoading(items);
		newItems = newItems.map((item) => {
			const newItem = item.clone();
			if (newItem.trakt) {
				delete newItem.trakt.watchedAt;
			}
			return newItem;
		});
		await store.update(newItems, true);
		newItems = await loadData(newItems);
		newItems = await stopLoading(newItems);
		return newItems;
	};

	const checkHiddenSelected = async (items: Item[]): Promise<Item[]> => {
		let index = -1;

		const newItems = [];
		const itemsToUpdate = [];
		for (const item of items) {
			const doHide = item.doHide();
			const isSelectable = item.isSelectable();
			if (item.isHidden !== doHide || (item.isSelected && !isSelectable)) {
				if (index < 0) {
					index = item.index;
				}

				const newItem = item.clone();
				if (item.isHidden !== doHide) {
					newItem.isHidden = doHide;
				}
				if (item.isSelected && !isSelectable) {
					newItem.isSelected = false;
				}
				newItems.push(newItem);
				itemsToUpdate.push(newItem);
			} else {
				newItems.push(item);
			}
		}
		if (itemsToUpdate.length > 0 && index > -1) {
			await store.update(itemsToUpdate, true);
			if (listRef.current) {
				listRef.current.resetAfterIndex(index);
			}
		}
		return newItems;
	};

	const isItemLoaded = useCallback(
		(index: number) => index < calculateTotalItems(serviceId, store),
		[]
	);

	const itemSize = useCallback(
		(index: number) => (store.data.items[index]?.isHidden ? 0 : 250),
		[]
	);

	const itemData = useMemo(() => ({ onContinueLoadingClick }), []);

	useEffect(() => {
		const startListeners = () => {
			EventDispatcher.subscribe('SERVICE_HISTORY_LOAD_ERROR', null, onHistoryLoadError);
			EventDispatcher.subscribe('TRAKT_HISTORY_LOAD_ERROR', null, onTraktHistoryLoadError);
			EventDispatcher.subscribe('MISSING_WATCHED_DATE_ADDED', null, onMissingWatchedDateAdded);
			EventDispatcher.subscribe('ITEM_CORRECTED', null, onItemCorrected);
			EventDispatcher.subscribe('HISTORY_SYNC_SUCCESS', null, onHistorySyncSuccess);
			EventDispatcher.subscribe('HISTORY_SYNC_ERROR', null, onHistorySyncError);
			EventDispatcher.subscribe('STORAGE_OPTIONS_CHANGE', null, onStorageOptionsChange);
			EventDispatcher.subscribe('ITEMS_LOAD', null, onItemsLoad);
			EventDispatcher.subscribe('SYNC_STORE_RESET', null, checkEnd);
		};

		const stopListeners = () => {
			EventDispatcher.unsubscribe('SERVICE_HISTORY_LOAD_ERROR', null, onHistoryLoadError);
			EventDispatcher.unsubscribe('TRAKT_HISTORY_LOAD_ERROR', null, onTraktHistoryLoadError);
			EventDispatcher.unsubscribe('MISSING_WATCHED_DATE_ADDED', null, onMissingWatchedDateAdded);
			EventDispatcher.unsubscribe('ITEM_CORRECTED', null, onItemCorrected);
			EventDispatcher.unsubscribe('HISTORY_SYNC_SUCCESS', null, onHistorySyncSuccess);
			EventDispatcher.unsubscribe('HISTORY_SYNC_ERROR', null, onHistorySyncError);
			EventDispatcher.unsubscribe('STORAGE_OPTIONS_CHANGE', null, onStorageOptionsChange);
			EventDispatcher.unsubscribe('ITEMS_LOAD', null, onItemsLoad);
			EventDispatcher.unsubscribe('SYNC_STORE_RESET', null, checkEnd);

			void EventDispatcher.dispatch('REQUESTS_CANCEL', null, { key: 'default' });
		};

		const onHistoryLoadError = async () => {
			history.push('/home');
			await EventDispatcher.dispatch('SNACKBAR_SHOW', null, {
				messageName: 'loadHistoryError',
				severity: 'error',
			});
		};

		const onTraktHistoryLoadError = async () => {
			await EventDispatcher.dispatch('SNACKBAR_SHOW', null, {
				messageName: 'loadTraktHistoryError',
				severity: 'error',
			});
		};

		const onMissingWatchedDateAdded = async (data: MissingWatchedDateAddedData): Promise<void> => {
			let newItems = data.newItems;
			newItems = await startLoading(newItems);
			await store.update(newItems, true);
			newItems = await loadData(newItems);
			await stopLoading(newItems);
		};

		const onItemCorrected = async (data: ItemCorrectedData): Promise<void> => {
			let newItem = Item.load(data.newItem);
			[newItem] = await startLoading([newItem]);
			try {
				if (data.oldItem.trakt?.syncId) {
					const oldItem = Item.load(data.oldItem);
					await TraktSync.removeHistory(oldItem);
				}
			} catch (err) {
				// Do nothing
			}
			await store.update([newItem], true);
			[newItem] = await loadData([newItem]);
			await stopLoading([newItem]);
		};

		const onHistorySyncSuccess = async (data: HistorySyncSuccessData) => {
			await EventDispatcher.dispatch('SNACKBAR_SHOW', null, {
				messageArgs: [data.added.episodes.toString(), data.added.movies.toString()],
				messageName: 'historySyncSuccess',
				severity: 'success',
			});
		};

		const onHistorySyncError = async () => {
			await EventDispatcher.dispatch('SNACKBAR_SHOW', null, {
				messageName: 'historySyncError',
				severity: 'error',
			});
		};

		const onStorageOptionsChange = async (data: StorageOptionsChangeData) => {
			if (!data.syncOptions) {
				return;
			}

			if (
				'addWithReleaseDate' in data.syncOptions ||
				'addWithReleaseDateMissing' in data.syncOptions
			) {
				await addWithReleaseDate(store.data.items);
			} else if ('hideSynced' in data.syncOptions || 'minPercentageWatched' in data.syncOptions) {
				await checkHiddenSelected(store.data.items);
			}
		};

		const onItemsLoad = () => {
			setItemCount(calculateItemCount(serviceId, store));
		};

		startListeners();
		return stopListeners;
	}, []);

	useEffect(() => {
		const checkIfContinueLoading = async () => {
			if (continueLoading) {
				await loadMoreItems(store.data.items.length, store.data.items.length + ITEMS_PER_LOAD);
			}
		};

		void checkIfContinueLoading();
	}, [continueLoading]);

	useEffect(() => {
		const checkLoad = async () => {
			if (store.data.items.length > 0) {
				let newItems = await startLoading(store.data.items);
				newItems = await loadData(newItems);
				await stopLoading(newItems);
			}
		};

		void checkLoad();
	}, []);

	return (
		<Box
			sx={{
				display: 'flex',
				flex: 1,
				justifyContent: 'center',
				height: 1,
				paddingLeft: ({ sizes }) => `${sizes.sidebar}px`,
			}}
		>
			<AutoSizer
				disableWidth
				style={{
					width: '100%',
				}}
			>
				{({ height }) => (
					<InfiniteLoader
						isItemLoaded={isItemLoaded}
						itemCount={itemCount}
						loadMoreItems={loadMoreItems}
						threshold={1}
					>
						{({ onItemsRendered, ref }) => (
							<VariableSizeList
								height={height}
								itemCount={itemCount}
								itemSize={itemSize}
								itemData={itemData}
								onItemsRendered={onItemsRendered}
								overscanCount={3}
								ref={(list) => {
									const infiniteLoaderRef = ref as RefCallback<
										VariableSizeList<HistoryListItemProps>
									>;
									infiniteLoaderRef(list);

									listRef.current = list;
								}}
								width="100%"
							>
								{HistoryListItem}
							</VariableSizeList>
						)}
					</InfiniteLoader>
				)}
			</AutoSizer>
		</Box>
	);
};
