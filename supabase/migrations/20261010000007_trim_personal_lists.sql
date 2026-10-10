-- The personal to-do list and suggestion dismissals were removed from the product.
set search_path = aangan, public, extensions;

drop table if exists suggestion_dismissals;
drop table if exists todos;
