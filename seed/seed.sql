-- Safe, repeatable seed. Creates the six flavors and default settings without
-- touching inventory, prices, or order data that already exist.

INSERT INTO products (slug, name, description, price_cents, stock_quantity, low_stock_threshold, sort_order)
VALUES
  ('milk-chocolate', 'Milk Chocolate', 'Smooth, creamy milk chocolate.', 200, 0, 10, 1),
  ('caramel', 'Caramel', 'Milk chocolate with a gooey caramel center.', 200, 0, 10, 2),
  ('crisp', 'Crisp', 'Milk chocolate with crispy rice.', 200, 0, 10, 3),
  ('wafer', 'Wafer', 'Milk chocolate with light, crunchy wafer.', 200, 0, 10, 4),
  ('almond', 'Almond', 'Milk chocolate with roasted almonds.', 200, 0, 10, 5),
  ('pretzel', 'Pretzel', 'Milk chocolate with salty pretzel pieces.', 200, 0, 10, 6)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO app_settings (key, value) VALUES ('ordering_enabled', '0')
ON CONFLICT (key) DO NOTHING;
