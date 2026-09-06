import {
  createProduct,
  deleteProduct,
  favoriteIds,
  getProduct,
  listFavorites,
  listForSeller,
  listProducts,
  toggleFavorite,
  updateProduct,
} from '../../src/modules/product/product.service';
import { ForbiddenError, NotFoundError } from '../../src/common/errors/ApiError';
import { makeClient, makeSeller } from '../helpers/factories';

const drill = {
  title: 'Bosch GBH 2-26 hammer drill',
  description: '800 W · SDS-plus · 12-month warranty',
  price: 1_890_000,
  stock: 5,
};

describe('product service', () => {
  it('creates a product with the design’s default gradient', async () => {
    const seller = await makeSeller();
    const product = await createProduct(seller.id as string, drill);

    expect(product.title).toBe(drill.title);
    expect(product.gradient.from).toBe('#8FAE91');
    expect(product.gradient.to).toBe('#5F7C63');
    expect(product.isActive).toBe(true);
  });

  it('honours an explicit gradient', async () => {
    const seller = await makeSeller();
    const product = await createProduct(seller.id as string, {
      ...drill,
      gradient: { from: '#7C9A7E', to: '#3E5341' },
    });

    expect(product.gradient).toMatchObject({ from: '#7C9A7E', to: '#3E5341' });
  });

  describe('updateProduct', () => {
    it('updates the seller’s own product', async () => {
      const seller = await makeSeller();
      const product = await createProduct(seller.id as string, drill);

      const updated = await updateProduct(product.id as string, seller.id as string, {
        price: 1_750_000,
      });

      expect(updated.price).toBe(1_750_000);
    });

    it('refuses another seller’s product', async () => {
      const owner = await makeSeller();
      const stranger = await makeSeller();
      const product = await createProduct(owner.id as string, drill);

      await expect(
        updateProduct(product.id as string, stranger.id as string, { price: 1 }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('throws for a product that does not exist', async () => {
      const seller = await makeSeller();
      await expect(
        updateProduct('507f1f77bcf86cd799439011', seller.id as string, { price: 1 }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('deleteProduct', () => {
    it('soft-deletes, so existing orders and reviews still resolve', async () => {
      const seller = await makeSeller();
      const product = await createProduct(seller.id as string, drill);

      await deleteProduct(product.id as string, seller.id as string);

      // Gone from the shop…
      expect((await listProducts({ page: 1, limit: 10 })).items).toHaveLength(0);
      // …but the row is still there.
      await expect(getProduct(product.id as string)).rejects.toThrow(NotFoundError);
    });

    it('refuses another seller’s product', async () => {
      const owner = await makeSeller();
      const stranger = await makeSeller();
      const product = await createProduct(owner.id as string, drill);

      await expect(deleteProduct(product.id as string, stranger.id as string)).rejects.toThrow(
        ForbiddenError,
      );
    });
  });

  describe('listProducts', () => {
    it('pages newest first', async () => {
      const seller = await makeSeller();
      await createProduct(seller.id as string, drill);
      await createProduct(seller.id as string, { ...drill, title: 'VVG cable 3×2.5' });
      await createProduct(seller.id as string, { ...drill, title: 'Ceresit tile adhesive' });

      const page = await listProducts({ page: 1, limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(3);
      expect(page.pages).toBe(2);
    });

    it('filters by seller', async () => {
      const first = await makeSeller();
      const second = await makeSeller();
      await createProduct(first.id as string, drill);
      await createProduct(second.id as string, { ...drill, title: 'Makita driver' });

      const page = await listProducts({ page: 1, limit: 10, seller: first.id as string });
      expect(page.items).toHaveLength(1);
    });

    it('filters by category', async () => {
      const seller = await makeSeller();
      await createProduct(seller.id as string, { ...drill, category: 'tools' });
      await createProduct(seller.id as string, { ...drill, category: 'materials' });

      const page = await listProducts({ page: 1, limit: 10, category: 'tools' });
      expect(page.items).toHaveLength(1);
    });
  });

  it('lists only a seller’s live products', async () => {
    const seller = await makeSeller();
    const keep = await createProduct(seller.id as string, drill);
    const drop = await createProduct(seller.id as string, { ...drill, title: 'Discontinued' });
    await deleteProduct(drop.id as string, seller.id as string);

    const mine = await listForSeller(seller.id as string);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBe(keep.id);
  });

  describe('favourites', () => {
    it('toggles on and back off', async () => {
      const seller = await makeSeller();
      const shopper = await makeClient();
      const product = await createProduct(seller.id as string, drill);

      expect(await toggleFavorite(shopper.id as string, product.id as string)).toEqual({
        favorited: true,
      });
      expect(await favoriteIds(shopper.id as string)).toEqual([product.id]);

      expect(await toggleFavorite(shopper.id as string, product.id as string)).toEqual({
        favorited: false,
      });
      expect(await favoriteIds(shopper.id as string)).toEqual([]);
    });

    it('returns the saved products themselves', async () => {
      const seller = await makeSeller();
      const shopper = await makeClient();
      const product = await createProduct(seller.id as string, drill);
      await toggleFavorite(shopper.id as string, product.id as string);

      const saved = await listFavorites(shopper.id as string);
      expect(saved).toHaveLength(1);
      expect(saved[0]!.title).toBe(drill.title);
    });

    it('drops a saved product that the seller has since removed', async () => {
      const seller = await makeSeller();
      const shopper = await makeClient();
      const product = await createProduct(seller.id as string, drill);
      await toggleFavorite(shopper.id as string, product.id as string);
      await deleteProduct(product.id as string, seller.id as string);

      expect(await listFavorites(shopper.id as string)).toHaveLength(0);
    });
  });
});
